// The stream forwarder on the JVM, with a backend that answers from memory: a request under
// `/remote/` reaches the backend with its head intact, anything else is 403 and never does,
// dot segments are refused however they are spelt, and no more than 32 connections are open.
package com.fareaststudios.cophyla

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class StreamForwarderTest {
    private val heads = CopyOnWriteArrayList<String>()
    private val held = CopyOnWriteArrayList<Socket>()
    @Volatile private var hold = false
    private val backend = StreamForwarder.Backend { conn, head, done ->
        heads.add(String(head, Charsets.ISO_8859_1))
        if (hold) {
            held.add(conn)
            return@Backend
        }
        conn.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
        conn.getOutputStream().flush()
        done()
    }
    private val forwarder = StreamForwarder(backend).also { it.start() }

    @After
    fun stop() {
        forwarder.close()
    }

    private fun exchange(request: String): String =
        Socket("127.0.0.1", forwarder.port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
            s.getOutputStream().flush()
            String(s.getInputStream().readBytes(), Charsets.ISO_8859_1)
        }

    @Test
    fun aStreamPageReachesTheBackendWithItsHead() {
        val request = "GET /remote/?t=abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        assertTrue(exchange(request).endsWith("\r\n\r\nok"))
        assertEquals(listOf(request), heads)
    }

    @Test
    fun anythingElseIsForbiddenAndNeverForwarded() {
        for (line in listOf("GET /ws/client HTTP/1.1", "GET /remote HTTP/1.1", "GET /remote/../ws/client HTTP/1.1", "GET /remote/%2e%2e/ws/client HTTP/1.1", "GET /remote/a\\..\\b HTTP/1.1", "CONNECT 192.168.1.44:4818 HTTP/1.1", "GET http://evil/remote/ HTTP/1.1")) {
            assertTrue(line, exchange("$line\r\nHost: x\r\n\r\n").startsWith("HTTP/1.1 403"))
        }
        assertEquals(emptyList<String>(), heads)
    }

    @Test
    fun theRequestLineIsJudgedAlone() {
        assertTrue(StreamForwarder.underRemote("GET /remote/api/host/stream/web_socket HTTP/1.1"))
        assertTrue(StreamForwarder.underRemote("POST /remote/api/user?x=../y HTTP/1.1"))
        assertFalse(StreamForwarder.underRemote("GET /remote/./x HTTP/1.1"))
        assertFalse(StreamForwarder.underRemote("GET /remote/x HTTP/2"))
        assertFalse(StreamForwarder.underRemote("get /remote/x HTTP/1.1"))
        assertEquals("GET /remote/ HTTP/1.1", StreamForwarder.firstLine("GET /remote/ HTTP/1.1\r\nHost: x\r\n".toByteArray()))
        assertNull(StreamForwarder.readHead(ByteArrayInputStream(ByteArray(9000) { 'a'.code.toByte() })))
        assertNull(StreamForwarder.readHead(ByteArrayInputStream("GET /remote/".toByteArray())))
    }

    @Test
    fun noMoreThan32ConnectionsAtOnce() {
        hold = true
        val clients = (1..StreamForwarder.MAX_CONNECTIONS).map {
            Socket("127.0.0.1", forwarder.port).also { s ->
                s.getOutputStream().write("GET /remote/ HTTP/1.1\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
            }
        }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (held.size < StreamForwarder.MAX_CONNECTIONS && System.nanoTime() < deadline) Thread.sleep(10)
        assertEquals(StreamForwarder.MAX_CONNECTIONS, held.size)
        // the 33rd is closed before a byte is read
        Socket("127.0.0.1", forwarder.port).use { extra ->
            extra.soTimeout = 5_000
            assertEquals(-1, extra.getInputStream().read())
        }
        // the stream ends: the held ones are cut
        val cut = CountDownLatch(1)
        Thread {
            if (clients[0].getInputStream().read() == -1) cut.countDown()
        }.start()
        forwarder.close()
        assertTrue(cut.await(5, TimeUnit.SECONDS))
        clients.forEach { it.close() }
    }
}
