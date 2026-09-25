// A forwarder on the phone's loopback, one per stream: the dialog's web view loads the stream
// page from `http://127.0.0.1:<port>`, and every connection it opens is carried on to the
// node by a backend. On the LAN that is a TLS socket to the node's controller listener,
// pinned to the key learned at pairing, the bytes pumped both ways as they come; a key that
// changed is refused and reported as `pin_mismatch`. Loopback is shared by every app on the
// phone, so the listener takes at most 32 connections at once and answers 403 to one whose
// first request line is not under `/remote/`: the node's other doors need a token anyway,
// and this one needs the stream's cookie.
package com.fareaststudios.cophyla

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

class StreamForwarder(private val backend: Backend) {
    /** Where one accepted connection goes. `head` is what was read of it to check the request line, sent on first; `done` once both ends are closed. */
    fun interface Backend {
        fun serve(conn: Socket, head: ByteArray, done: () -> Unit)
    }

    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val conns = ConcurrentHashMap.newKeySet<Socket>()
    private val closed = AtomicBoolean(false)

    val port: Int get() = server.localPort

    fun start() {
        Thread({ acceptLoop() }, "cophyla-stream-accept").apply { isDaemon = true }.start()
    }

    /** The stream ended: no new connections, and the open ones are cut. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        closeQuietly(server)
        for (c in conns) closeQuietly(c)
        conns.clear()
    }

    private fun acceptLoop() {
        while (!closed.get()) {
            val conn = try {
                server.accept()
            } catch (e: IOException) {
                break
            }
            if (conns.size >= MAX_CONNECTIONS || closed.get()) {
                closeQuietly(conn)
                continue
            }
            conns.add(conn)
            Thread({ handle(conn) }, "cophyla-stream-conn").apply { isDaemon = true }.start()
        }
    }

    private fun handle(conn: Socket) {
        val done = {
            conns.remove(conn)
            closeQuietly(conn)
        }
        try {
            conn.tcpNoDelay = true
            conn.soTimeout = HEAD_TIMEOUT_MS
            val head = readHead(conn.getInputStream())
            conn.soTimeout = 0
            if (head == null || !underRemote(firstLine(head))) {
                conn.getOutputStream().apply {
                    write(FORBIDDEN)
                    flush()
                }
                done()
                return
            }
            backend.serve(conn, head, done)
        } catch (e: Exception) {
            done()
        }
    }

    companion object {
        const val MAX_CONNECTIONS = 32
        private const val HEAD_MAX = 8 * 1024
        private const val HEAD_TIMEOUT_MS = 10_000
        private val FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)
        private val REQUEST_LINE = Regex("^[A-Z]{3,7} (/remote/[^ ]*) HTTP/1\\.[01]$")

        /** The bytes up to and including the first line, and whatever came with them; null when no line came within the limit. */
        fun readHead(input: InputStream): ByteArray? {
            val buf = ByteArray(HEAD_MAX)
            var n = 0
            while (n < HEAD_MAX) {
                val read = input.read(buf, n, HEAD_MAX - n)
                if (read < 0) return null
                val from = n
                n += read
                for (i in from until n) if (buf[i] == '\n'.code.toByte()) return buf.copyOf(n)
            }
            return null
        }

        fun firstLine(head: ByteArray): String {
            val end = head.indexOf('\n'.code.toByte())
            return String(head, 0, if (end < 0) head.size else end, Charsets.ISO_8859_1).trimEnd('\r')
        }

        /** A request under `/remote/` that climbs nowhere: no dot segments, plain or encoded, and no backslash. */
        fun underRemote(line: String): Boolean {
            val target = REQUEST_LINE.matchEntire(line)?.groupValues?.get(1) ?: return false
            val path = target.substringBefore('?')
            if (path.contains('\\') || path.contains("%2e", ignoreCase = true) || path.contains("%2f", ignoreCase = true)) return false
            return path.split('/').none { it == "." || it == ".." }
        }

        fun closeQuietly(c: java.io.Closeable?) {
            try {
                c?.close()
            } catch (e: Exception) {
                // closing anyway
            }
        }
    }
}

/**
 * The LAN backend: each connection becomes a TLS socket to the node's controller listener,
 * pinned to the key learned at pairing. `probe` opens one before the stream shows, so a
 * changed key is refused there; one found later ends the stream through `onError`.
 */
class LanBackend(private val host: String, private val port: Int, pin: String, private val onError: (String) -> Unit) : StreamForwarder.Backend {
    private val factory: SSLSocketFactory = PinnedTls.context(LeafTrust(pin)).socketFactory

    /** One handshake with the node, closed at once: throws what opening a connection would. */
    fun probe() {
        open().close()
    }

    private fun open(): SSLSocket {
        val raw = Socket()
        try {
            raw.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            raw.tcpNoDelay = true
            val tls = factory.createSocket(raw, host, port, true) as SSLSocket
            tls.startHandshake()
            return tls
        } catch (e: Exception) {
            StreamForwarder.closeQuietly(raw)
            throw e
        }
    }

    override fun serve(conn: Socket, head: ByteArray, done: () -> Unit) {
        val up = try {
            open()
        } catch (e: Exception) {
            if (PinnedTls.isPinMismatch(e)) onError(PinnedTls.PIN_MISMATCH)
            done()
            return
        }
        val ends = AtomicInteger(0)
        val end = {
            if (ends.incrementAndGet() == 2) {
                StreamForwarder.closeQuietly(up)
                done()
            }
        }
        val cut = {
            StreamForwarder.closeQuietly(up)
            StreamForwarder.closeQuietly(conn)
        }
        try {
            up.outputStream.apply {
                write(head)
                flush()
            }
        } catch (e: IOException) {
            cut()
            done()
            return
        }
        // the web view never half-closes: its end of input is the end of the connection, and TLS here cannot half-close anyway
        Thread({ pump(conn.getInputStream(), up.outputStream, { StreamForwarder.closeQuietly(up) }, cut, end) }, "cophyla-stream-up").apply { isDaemon = true }.start()
        pump(up.inputStream, conn.getOutputStream(), { halfClose(conn) }, cut, end)
    }

    private fun halfClose(s: Socket) {
        try {
            s.shutdownOutput()
        } catch (e: Exception) {
            StreamForwarder.closeQuietly(s)
        }
    }

    private fun pump(from: InputStream, to: OutputStream, eof: () -> Unit, cut: () -> Unit, end: () -> Unit) {
        val buf = ByteArray(BUFFER)
        try {
            while (true) {
                val n = from.read(buf)
                if (n < 0) break
                to.write(buf, 0, n)
                to.flush()
            }
            eof()
        } catch (e: IOException) {
            cut()
        } finally {
            end()
        }
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val BUFFER = 64 * 1024
    }
}
