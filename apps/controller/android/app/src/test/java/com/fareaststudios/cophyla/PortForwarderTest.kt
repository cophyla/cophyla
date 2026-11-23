// The port forwarder on the JVM: the cookie check on a request's head (HTTP/1.x for a path
// here, the cookie by name with the secret, among others and in any Cookie header, and nothing
// else), a head read through its blank line up to 16 KiB, the port chosen (the machine's own
// when free on both loopbacks, else one free on both), and a forwarder with a backend that
// answers from memory: a request with the cookie reaches it, head intact, on 127.0.0.1 and on
// ::1, and one without is 403 and never does; a TLS server's first bytes are known for one; and
// a port backend's connections are named apart, its first bytes down checked before they go.
package com.fareaststudios.cophyla

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PortForwarderTest {
    private val id = "prt_01ARZ3NDEKTSV4RRFFQ69G5FP1"
    private val name = "cophyla_port_$id"
    private val secret = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978"
    private val opened = CopyOnWriteArrayList<ServerSocket>()

    @After
    fun stop() {
        for (s in opened) StreamForwarder.closeQuietly(s)
    }

    private fun head(vararg lines: String): ByteArray = (lines.joinToString("\r\n") + "\r\n\r\n").toByteArray(Charsets.ISO_8859_1)

    @Test
    fun aRequestWithTheCookieIsLetIn() {
        assertTrue(PortForwarder.allowed(head("GET / HTTP/1.1", "Host: localhost:3000", "Cookie: $name=$secret"), name, secret))
        // among the site's own cookies, in a second Cookie header, spaced as browsers do
        assertTrue(PortForwarder.allowed(head("GET /src/main.ts?t=1 HTTP/1.1", "Host: 127.0.0.1:3000", "cookie: session=abc; theme=dark", "Cookie: a=1;  $name=$secret ; b=2"), name, secret))
        assertTrue(PortForwarder.allowed(head("POST /api/login HTTP/1.0", "Cookie:$name=$secret", "Content-Length: 0"), name, secret))
    }

    @Test
    fun anythingElseIsNot() {
        val bad = listOf(
            head("GET / HTTP/1.1", "Host: localhost:3000"),
            head("GET / HTTP/1.1", "Cookie: $name=wrong"),
            head("GET / HTTP/1.1", "Cookie: $name=${secret}x"),
            head("GET / HTTP/1.1", "Cookie: cophyla_port_prt_01ARZ3NDEKTSV4RRFFQ69G5FP2=$secret"),
            head("GET / HTTP/1.1", "X-Cookie: $name=$secret"),
            head("GET / HTTP/1.1", "Referer: http://x/?$name=$secret"),
            head("GET / HTTP/2", "Cookie: $name=$secret"),
            head("GET http://evil.example/ HTTP/1.1", "Cookie: $name=$secret"),
            head("CONNECT 192.168.1.44:4818 HTTP/1.1", "Cookie: $name=$secret"),
            head("get / HTTP/1.1", "Cookie: $name=$secret"),
            // no blank line: the head never ended
            "GET / HTTP/1.1\r\nCookie: $name=$secret\r\n".toByteArray(Charsets.ISO_8859_1),
            // TLS's first record, not HTTP at all
            byteArrayOf(0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00),
        )
        for (h in bad) assertFalse(String(h, Charsets.ISO_8859_1), PortForwarder.allowed(h, name, secret))
    }

    @Test
    fun aHeadIsReadThroughItsBlankLineUpTo16KiB() {
        val request = "GET / HTTP/1.1\r\nCookie: $name=$secret\r\n\r\nbody"
        assertArrayEquals(request.toByteArray(), PortForwarder.readHead(ByteArrayInputStream(request.toByteArray())))
        // long cookies fit
        val long = "GET / HTTP/1.1\r\nCookie: big=${"x".repeat(12_000)}; $name=$secret\r\n\r\n"
        val read = PortForwarder.readHead(ByteArrayInputStream(long.toByteArray()))!!
        assertTrue(PortForwarder.allowed(read, name, secret))
        assertNull(PortForwarder.readHead(ByteArrayInputStream("GET / HTTP/1.1\r\nHost: x\r\n".toByteArray())))
        assertNull(PortForwarder.readHead(ByteArrayInputStream(("GET / HTTP/1.1\r\nX: " + "y".repeat(PortForwarder.HEAD_MAX) + "\r\n\r\n").toByteArray())))
    }

    @Test
    fun thePortIsTheMachinesWhenFreeOnBoth() {
        val free = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val servers = PortForwarder.listen(free).also { opened.addAll(it) }
        assertEquals(listOf(free, free), servers.map { it.localPort })
        assertEquals(setOf("127.0.0.1", "0:0:0:0:0:0:0:1"), servers.map { it.inetAddress.hostAddress }.toSet())
    }

    @Test
    fun takenOnEitherLoopbackAnotherIsFreeOnBoth() {
        for (taken in listOf("127.0.0.1", "::1")) {
            val holder = ServerSocket(0, 50, InetAddress.getByName(taken)).also { opened.add(it) }
            val servers = PortForwarder.listen(holder.localPort).also { opened.addAll(it) }
            assertNotEquals(taken, holder.localPort, servers[0].localPort)
            assertEquals(2, servers.size)
            assertEquals(servers[0].localPort, servers[1].localPort)
        }
    }

    @Test
    fun aPhoneWithoutIpv6ListensOn127Alone() {
        val v4only: (InetAddress, Int) -> ServerSocket = { address, port ->
            if (address.hostAddress!!.contains(':')) throw java.net.BindException("Cannot assign requested address")
            PortForwarder.bindOn(address, port)
        }
        val servers = PortForwarder.listen(0, v4only).also { opened.addAll(it) }
        assertEquals(listOf("127.0.0.1"), servers.map { it.inetAddress.hostAddress })
    }

    @Test
    fun aTlsServersAnswerIsKnown() {
        assertTrue(PortForwarder.looksLikeTls(byteArrayOf(0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46)))
        assertTrue(PortForwarder.looksLikeTls(byteArrayOf(0x16, 0x03, 0x03, 0x00, 0x7a)))
        assertFalse(PortForwarder.looksLikeTls("HTTP/1.1 200 OK\r\n".toByteArray()))
        assertFalse(PortForwarder.looksLikeTls(byteArrayOf(0x16, 0x03)))
        assertFalse(PortForwarder.looksLikeTls(byteArrayOf(0x17, 0x03, 0x03)))
    }

    @Test
    fun theForwarderLetsTheCookieInOnBothLoopbacksAndNothingElse() {
        val heads = CopyOnWriteArrayList<String>()
        val backend = StreamForwarder.Backend { conn, h, done ->
            heads.add(String(h, Charsets.ISO_8859_1))
            conn.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
            conn.getOutputStream().flush()
            done()
        }
        val forwarder = PortForwarder(0, id, backend).also { it.start() }
        try {
            fun exchange(host: String, request: String): String =
                Socket(host, forwarder.port).use { s ->
                    s.soTimeout = 5_000
                    s.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
                    s.getOutputStream().flush()
                    String(s.getInputStream().readBytes(), Charsets.ISO_8859_1)
                }
            val good = "GET / HTTP/1.1\r\nHost: localhost\r\nCookie: ${forwarder.cookieName}=${forwarder.secret}\r\n\r\n"
            assertTrue(exchange("127.0.0.1", good).endsWith("\r\n\r\nok"))
            assertTrue(exchange("::1", good).endsWith("\r\n\r\nok"))
            assertEquals(listOf(good, good), heads)
            assertTrue(exchange("127.0.0.1", "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").startsWith("HTTP/1.1 403"))
            assertTrue(exchange("::1", "GET / HTTP/1.1\r\nCookie: ${forwarder.cookieName}=guess\r\n\r\n").startsWith("HTTP/1.1 403"))
            assertEquals(2, heads.size)
            assertEquals(48, forwarder.secret.length)
        } finally {
            forwarder.close()
        }
    }

    @Test
    fun aPortBackendNamesItsConnectionsApartAndChecksTheFirstBytesDown() {
        val conns = LinkedBlockingQueue<String>()
        val ended = LinkedBlockingQueue<Pair<String, String>>()
        val events = object : PipeBackend.Events {
            override fun connection(conn: String) {
                conns.add(conn)
            }

            override fun data(conn: String, bytes: ByteArray) {}

            override fun written(conn: String, bytes: Int) {}

            override fun ended(conn: String, reason: String) {
                ended.add(conn to reason)
            }
        }
        val pipes = PipeBackend(events, openTimeoutMs = 2_000, prefix = "q", firstDown = { !PortForwarder.looksLikeTls(it) })
        val forwarder = PortForwarder(0, id, pipes).also { it.start() }
        try {
            Socket("127.0.0.1", forwarder.port).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET / HTTP/1.1\r\nCookie: ${forwarder.cookieName}=${forwarder.secret}\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                val conn = conns.poll(5, TimeUnit.SECONDS)!!
                assertTrue(conn, conn.startsWith("q"))
                assertTrue(pipes.opened(conn, 65_536))
                // an HTTPS server's alert never reaches the page: the connection ends instead
                pipes.write(conn, byteArrayOf(0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46))
                assertEquals(conn to "the page could not be read", ended.poll(5, TimeUnit.SECONDS))
                assertEquals(-1, s.getInputStream().read())
            }
        } finally {
            forwarder.close()
            pipes.closeAll()
        }
    }
}
