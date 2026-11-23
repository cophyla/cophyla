// A forwarder on the phone's loopback for a port of one of the user's machines, opened from the
// phone: the port dialog's web view loads `http://localhost:<port>/`, and every connection it
// opens is carried on by a backend (PipeBackend: a pipe over the app's link to that machine,
// which connects to its own loopback there). It listens on 127.0.0.1 and ::1 alike, since a page
// may name either, on the machine's own port number when that is free on both here, so links
// and redirects that name the port keep working; else on one free on both. Loopback is shared
// by every app on the phone and Android cannot say which app opened a connection, so the page
// carries a secret instead: a cookie the dialog sets for the page's origin before it loads it
// (`cophyla_port_<id>`, HttpOnly), which the first request of every connection must bring, else
// it is answered 403 and closed. Cookies ignore ports, so one set for `localhost` reaches the
// page at whatever port it ended on. At most 32 connections are open at once.
package com.fareaststudios.cophyla

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

class PortForwarder(preferred: Int, id: String, private val backend: StreamForwarder.Backend) {
    /** The cookie a connection's first request must carry, and its value. */
    val cookieName = "cophyla_port_$id"
    val secret: String = newSecret()

    private val servers: List<ServerSocket> = listen(preferred)
    private val conns = ConcurrentHashMap.newKeySet<Socket>()
    private val closed = AtomicBoolean(false)

    /** The port the page is reached at here: the machine's own when it was free on both loopbacks. */
    val port: Int = servers.first().localPort

    fun start() {
        for (server in servers) Thread({ acceptLoop(server) }, "cophyla-port-accept").apply { isDaemon = true }.start()
    }

    /** The page closed: no new connections, and the open ones are cut. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        for (s in servers) StreamForwarder.closeQuietly(s)
        for (c in conns) StreamForwarder.closeQuietly(c)
        conns.clear()
    }

    private fun acceptLoop(server: ServerSocket) {
        while (!closed.get()) {
            val conn = try {
                server.accept()
            } catch (e: IOException) {
                break
            }
            if (conns.size >= MAX_CONNECTIONS || closed.get()) {
                StreamForwarder.closeQuietly(conn)
                continue
            }
            conns.add(conn)
            Thread({ handle(conn) }, "cophyla-port-conn").apply { isDaemon = true }.start()
        }
    }

    private fun handle(conn: Socket) {
        val done = {
            conns.remove(conn)
            StreamForwarder.closeQuietly(conn)
        }
        try {
            conn.tcpNoDelay = true
            conn.soTimeout = HEAD_TIMEOUT_MS
            val head = readHead(conn.getInputStream())
            conn.soTimeout = 0
            if (head == null || !allowed(head, cookieName, secret)) {
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
        /** The most of a request's head read to find its cookie: cookies can be long. */
        const val HEAD_MAX = 16 * 1024
        private const val HEAD_TIMEOUT_MS = 10_000
        /** How many free ports are tried for one that is free on both loopbacks. */
        private const val TRIES = 8
        private val FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)
        /** A request for a path on this origin: never a proxy's absolute URL, never CONNECT's host. */
        private val REQUEST_LINE = Regex("^[A-Z]{3,10} /[^ ]* HTTP/1\\.[01]$")
        private val V4: InetAddress = InetAddress.getByName("127.0.0.1")
        private val V6: InetAddress = InetAddress.getByName("::1")

        /** 24 random bytes, as hex: a cookie's value needs no escaping then. */
        fun newSecret(): String {
            val bytes = ByteArray(24)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }

        /** A listening socket on `address` at `port` (0 for any free one). */
        fun bindOn(address: InetAddress, port: Int): ServerSocket =
            ServerSocket().also { s ->
                try {
                    s.bind(InetSocketAddress(address, port), 50)
                } catch (e: IOException) {
                    StreamForwarder.closeQuietly(s)
                    throw e
                }
            }

        /**
         * Listening sockets on 127.0.0.1 and ::1 at one port: `preferred` when it is free on both
         * (a port under 1024 never is, to an app), else a free one that is free on both; on a phone
         * whose loopback has no IPv6, 127.0.0.1 alone.
         */
        fun listen(preferred: Int, bind: (InetAddress, Int) -> ServerSocket = ::bindOn): List<ServerSocket> {
            val v6 = try {
                bind(V6, 0).close()
                true
            } catch (e: IOException) {
                false
            }
            // port 0 asks for any: each loopback would get one of its own
            if (preferred in 1..65535) both(preferred, v6, bind)?.let { return it }
            repeat(TRIES) {
                val first = bind(V4, 0)
                if (!v6) return listOf(first)
                val second = tryBind(V6, first.localPort, bind)
                if (second != null) return listOf(first, second)
                StreamForwarder.closeQuietly(first)
            }
            throw IOException("no port is free on both loopbacks")
        }

        /** Both loopbacks at `port`, or none of them when either is taken. */
        private fun both(port: Int, v6: Boolean, bind: (InetAddress, Int) -> ServerSocket): List<ServerSocket>? {
            val first = tryBind(V4, port, bind) ?: return null
            if (!v6) return listOf(first)
            val second = tryBind(V6, port, bind)
            if (second == null) {
                StreamForwarder.closeQuietly(first)
                return null
            }
            return listOf(first, second)
        }

        private fun tryBind(address: InetAddress, port: Int, bind: (InetAddress, Int) -> ServerSocket): ServerSocket? =
            try {
                bind(address, port)
            } catch (e: IOException) {
                null
            }

        /** A request's head, through the blank line that ends it, and whatever came with it; null when it did not end within `max`. */
        fun readHead(input: InputStream, max: Int = HEAD_MAX): ByteArray? {
            val buf = ByteArray(max)
            var n = 0
            while (n < max) {
                val read = input.read(buf, n, max - n)
                if (read < 0) return null
                val from = maxOf(0, n - 3)
                n += read
                for (i in from..n - 4) {
                    if (buf[i] == CR && buf[i + 1] == LF && buf[i + 2] == CR && buf[i + 3] == LF) return buf.copyOf(n)
                }
            }
            return null
        }

        /** Whether a request's head is HTTP/1.x for a path here and carries the cookie `name` with `secret`. */
        fun allowed(head: ByteArray, name: String, secret: String): Boolean {
            val text = String(head, Charsets.ISO_8859_1)
            val end = text.indexOf("\r\n\r\n")
            if (end < 0) return false
            val lines = text.substring(0, end).split("\r\n")
            if (!REQUEST_LINE.matches(lines[0])) return false
            val want = secret.toByteArray(Charsets.US_ASCII)
            var found = false
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':')
                if (colon <= 0 || !line.substring(0, colon).trim().equals("cookie", ignoreCase = true)) continue
                for (pair in line.substring(colon + 1).split(';')) {
                    val eq = pair.indexOf('=')
                    if (eq < 0 || pair.substring(0, eq).trim() != name) continue
                    // compared in constant time: a page elsewhere on the phone learns nothing by timing it
                    if (MessageDigest.isEqual(pair.substring(eq + 1).trim().toByteArray(Charsets.ISO_8859_1), want)) found = true
                }
            }
            return found
        }

        /** Whether bytes a server sent look like a TLS record (an alert or a handshake): an HTTPS server answering plain HTTP. */
        fun looksLikeTls(bytes: ByteArray): Boolean =
            bytes.size >= 3 && (bytes[0] == TLS_ALERT || bytes[0] == TLS_HANDSHAKE) && bytes[1] == TLS_MAJOR && bytes[2].toInt() in 0..4

        private const val CR: Byte = 13
        private const val LF: Byte = 10
        private const val TLS_ALERT: Byte = 0x15
        private const val TLS_HANDSHAKE: Byte = 0x16
        private const val TLS_MAJOR: Byte = 0x03
    }
}
