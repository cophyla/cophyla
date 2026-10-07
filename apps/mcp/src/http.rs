//! The one HTTP request the shim makes: a POST to cophylad on loopback, `Connection: close`,
//! read back whole. An HTTP crate would bring a runtime and a TLS stack for a request that
//! never leaves the machine; this reads what Bun's server writes (a `Content-Length` body, a
//! chunked one, or one that ends when the connection does) and nothing more.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// The most a status line and its headers may take, so a stray server cannot grow the shim.
const HEAD_LIMIT: usize = 64 * 1024;
/// The most a body may take. cophylad's answers are a tool list or a tool's text.
const BODY_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Reads from the stream until a deadline for the whole answer, where the socket's own timeout
/// bounds each read alone: a server that trickles a byte a second still ends on time.
struct Deadline<'a> {
    stream: &'a TcpStream,
    until: Instant,
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "cophylad did not answer in time"));
        }
        self.stream.set_read_timeout(Some(left))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

/// Why a request has no answer: it never reached cophylad, or it did and no whole answer came back.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    NotSent,
    NoAnswer,
}

/// POSTs `body` to `http://127.0.0.1:<port><path>` and reads the whole answer within `timeout`.
pub fn post(port: u16, token: &str, path: &str, body: &[u8], connect: Duration, timeout: Duration) -> Result<Response, Failure> {
    let stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), connect).map_err(|_| Failure::NotSent)?;
    stream.set_write_timeout(Some(timeout)).map_err(|_| Failure::NotSent)?;
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(body);
    (&stream).write_all(&request).map_err(|_| Failure::NotSent)?;
    let mut reader = BufReader::new(Deadline { stream: &stream, until: Instant::now() + timeout });
    read_response(&mut reader).map_err(|_| Failure::NoAnswer)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// One line, its CRLF (or a bare LF) taken off; an error at the end of the stream.
fn read_line<R: BufRead>(r: &mut R, used: &mut usize, limit: usize) -> io::Result<String> {
    let mut line = Vec::new();
    let n = r.by_ref().take(limit.saturating_sub(*used).saturating_add(1) as u64).read_until(b'\n', &mut line)?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the answer ended early"));
    }
    *used += n;
    if *used > limit {
        return Err(invalid("the answer's head is too long"));
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| invalid("the answer's head is not text"))
}

/// The status line and headers, with interim `1xx` answers passed over (none is asked for, but
/// a server may send one): the status, whether the body is chunked, and its length when given.
fn read_head<R: BufRead>(r: &mut R) -> io::Result<(u16, bool, Option<usize>)> {
    let mut used = 0;
    loop {
        let status_line = read_line(r, &mut used, HEAD_LIMIT)?;
        let mut parts = status_line.split_whitespace();
        let version = parts.next().unwrap_or("");
        if !version.starts_with("HTTP/") {
            return Err(invalid("not an HTTP answer"));
        }
        let status: u16 = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| invalid("no status in the answer"))?;
        let mut chunked = false;
        let mut length = None;
        loop {
            let line = read_line(r, &mut used, HEAD_LIMIT)?;
            if line.is_empty() {
                break;
            }
            let Some((name, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            if name.trim().eq_ignore_ascii_case("transfer-encoding") {
                // the last coding is the one that frames the body
                chunked = value.rsplit(',').next().is_some_and(|c| c.trim().eq_ignore_ascii_case("chunked"));
            } else if name.trim().eq_ignore_ascii_case("content-length") {
                length = Some(value.parse::<usize>().map_err(|_| invalid("a bad Content-Length"))?);
            }
        }
        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        return Ok((status, chunked, length));
    }
}

/// A chunked body: each chunk's hex size (its extensions ignored), the chunk and its CRLF, up
/// to the zero-size one and the trailers after it.
pub fn read_chunked<R: BufRead>(r: &mut R) -> io::Result<Vec<u8>> {
    // each size line and trailer is held to the head's limit on its own; the body's bounds the rest
    let line = |r: &mut R| read_line(r, &mut 0, HEAD_LIMIT);
    let mut body = Vec::new();
    loop {
        let size_line = line(r)?;
        let hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(hex, 16).map_err(|_| invalid("a bad chunk size"))?;
        if size == 0 {
            // trailers, up to the empty line; a server that closes right after the last chunk has said everything
            loop {
                match line(r) {
                    Ok(trailer) if !trailer.is_empty() => continue,
                    Ok(_) => return Ok(body),
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(body),
                    Err(e) => return Err(e),
                }
            }
        }
        if size > BODY_LIMIT - body.len() {
            return Err(invalid("the answer is too long"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        r.read_exact(&mut body[start..])?;
        if !line(r)?.is_empty() {
            return Err(invalid("a chunk longer than its size"));
        }
    }
}

/// A whole answer: its head, then its body framed as the head says.
pub fn read_response<R: BufRead>(r: &mut R) -> io::Result<Response> {
    let (status, chunked, length) = read_head(r)?;
    let body = if status == 204 || status == 304 {
        Vec::new()
    } else if chunked {
        read_chunked(r)?
    } else if let Some(n) = length {
        if n > BODY_LIMIT {
            return Err(invalid("the answer is too long"));
        }
        let mut body = vec![0; n];
        r.read_exact(&mut body)?;
        body
    } else {
        let mut body = Vec::new();
        r.take(BODY_LIMIT as u64 + 1).read_to_end(&mut body)?;
        if body.len() > BODY_LIMIT {
            return Err(invalid("the answer is too long"));
        }
        body
    };
    Ok(Response { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse(raw: &str) -> io::Result<Response> {
        read_response(&mut Cursor::new(raw.as_bytes().to_vec()))
    }

    #[test]
    fn a_chunked_body_is_joined_with_extensions_and_trailers_passed_over() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n7;name=x\r\n{\"a\":1,\r\n6\r\n\"b\":2}\r\n0\r\nX-Trailer: y\r\n\r\n";
        assert_eq!(parse(raw).unwrap(), Response { status: 200, body: b"{\"a\":1,\"b\":2}".to_vec() });
    }

    #[test]
    fn a_chunked_body_may_end_with_the_connection_after_its_last_chunk() {
        let raw = "HTTP/1.1 200 OK\r\ntransfer-encoding: gzip, chunked\r\n\r\nA\r\n0123456789\r\n0\r\n";
        assert_eq!(parse(raw).unwrap().body, b"0123456789");
    }

    #[test]
    fn a_chunk_cut_short_or_misframed_is_an_error() {
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort").is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabc\r\n0\r\n\r\n").is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").is_err());
    }

    #[test]
    fn a_content_length_body_is_read_to_its_length() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA";
        assert_eq!(parse(raw).unwrap().body, b"hello");
        assert!(parse("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nhello").is_err());
    }

    #[test]
    fn a_body_with_no_length_runs_to_the_end_of_the_stream() {
        assert_eq!(parse("HTTP/1.1 200 OK\r\n\r\n{\"x\":true}").unwrap().body, b"{\"x\":true}");
    }

    #[test]
    fn no_content_has_no_body_and_interim_answers_are_passed_over() {
        assert_eq!(parse("HTTP/1.1 204 No Content\r\n\r\n").unwrap(), Response { status: 204, body: vec![] });
        let raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse(raw).unwrap(), Response { status: 202, body: vec![] });
    }

    #[test]
    fn something_other_than_http_is_an_error() {
        assert!(parse("SSH-2.0-OpenSSH\r\n\r\n").is_err());
        assert!(parse("").is_err());
    }
}
