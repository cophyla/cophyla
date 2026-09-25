// The link backend on the JVM, behind a real forwarder, with the page's side played by the
// test: a connection asks for a pipe and waits for it; its head goes first, then its bytes
// only as far as the window allows, more once acks come; the node's bytes are written in
// order and each write reported; the node closing the pipe closes the connection once its
// bytes are out; the web view closing reports the end once; a pipe that never opens closes
// the connection quietly.
package com.fareaststudios.cophyla

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PipeBackendTest {
    private val connections = LinkedBlockingQueue<String>()
    private val data = LinkedBlockingQueue<Pair<String, ByteArray>>()
    private val written = CopyOnWriteArrayList<Pair<String, Int>>()
    private val ended = CopyOnWriteArrayList<Pair<String, String>>()
    private val events = object : PipeBackend.Events {
        override fun connection(conn: String) {
            connections.add(conn)
        }

        override fun data(conn: String, bytes: ByteArray) {
            data.add(conn to bytes)
        }

        override fun written(conn: String, bytes: Int) {
            written.add(conn to bytes)
        }

        override fun ended(conn: String, reason: String) {
            ended.add(conn to reason)
        }
    }
    private val pipes = PipeBackend(events, openTimeoutMs = 500)
    private val forwarder = StreamForwarder(pipes).also { it.start() }

    @After
    fun stop() {
        forwarder.close()
        pipes.closeAll()
    }

    private fun connect(request: String): Socket =
        Socket("127.0.0.1", forwarder.port).also { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
            s.getOutputStream().flush()
        }

    /** Everything sent up within `ms`. */
    private fun drain(ms: Long): ByteArray {
        val out = ByteArrayOutputStream()
        val end = System.currentTimeMillis() + ms
        while (true) {
            val left = end - System.currentTimeMillis()
            if (left <= 0) break
            val next = data.poll(left, TimeUnit.MILLISECONDS) ?: break
            out.write(next.second)
        }
        return out.toByteArray()
    }

    private fun waitUntil(what: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!what()) {
            assertTrue("timed out", System.currentTimeMillis() < end)
            Thread.sleep(10)
        }
    }

    @Test
    fun theHeadGoesFirstThenNoMoreThanTheWindowUntilAcked() {
        val head = "GET /remote/?t=abc HTTP/1.1\r\n"
        val s = connect(head)
        val conn = connections.poll(5, TimeUnit.SECONDS)!!
        assertTrue(drain(200).isEmpty())
        assertTrue(pipes.opened(conn, head.length + 4))
        assertEquals(head, String(drain(300), Charsets.ISO_8859_1))
        s.getOutputStream().write("Host: 127.0.0.1\r\n\r\n".toByteArray())
        s.getOutputStream().flush()
        // four bytes of window left: four come, then nothing until an ack
        assertEquals("Host", String(drain(300), Charsets.ISO_8859_1))
        pipes.ack(conn, 100)
        assertEquals(": 127.0.0.1\r\n\r\n", String(drain(300), Charsets.ISO_8859_1))
        s.close()
    }

    @Test
    fun theNodesBytesAreWrittenInOrderAndReportedAndItsCloseComesAfterThem() {
        val s = connect("GET /remote/ HTTP/1.1\r\n\r\n")
        val conn = connections.poll(5, TimeUnit.SECONDS)!!
        pipes.opened(conn, 1 shl 18)
        drain(200)
        val parts = listOf("HTTP/1.1 200 OK\r\n", "Content-Length: 2\r\n\r\n", "ok")
        for (p in parts) pipes.write(conn, p.toByteArray())
        pipes.close(conn)
        assertEquals(parts.joinToString(""), String(s.getInputStream().readBytes(), Charsets.ISO_8859_1))
        waitUntil { written.size == 3 }
        assertEquals(parts.map { conn to it.length }, written.toList())
        // closed by the node: no end reported back to it
        assertEquals(0, ended.size)
        waitUntil { pipes.count == 0 }
    }

    @Test
    fun theWebViewClosingIsReportedOnce() {
        val s = connect("GET /remote/ HTTP/1.1\r\n\r\n")
        val conn = connections.poll(5, TimeUnit.SECONDS)!!
        pipes.opened(conn, 1 shl 18)
        drain(200)
        s.close()
        waitUntil { ended.isNotEmpty() }
        Thread.sleep(100)
        assertEquals(listOf(conn to "the page closed it"), ended.toList())
        assertEquals(0, pipes.count)
        // a late write and ack for it are ignored
        pipes.write(conn, "late".toByteArray())
        pipes.ack(conn, 4)
        assertFalse(pipes.opened(conn, 10))
    }

    @Test
    fun aPipeThatNeverOpensClosesTheConnectionQuietly() {
        val s = connect("GET /remote/ HTTP/1.1\r\n\r\n")
        val conn = connections.poll(5, TimeUnit.SECONDS)!!
        assertEquals(-1, s.getInputStream().read())
        assertEquals(0, ended.size)
        assertFalse(pipes.opened(conn, 10))
        // and one refused is closed at once
        val t = connect("GET /remote/ HTTP/1.1\r\n\r\n")
        val refused = connections.poll(5, TimeUnit.SECONDS)!!
        pipes.failed(refused)
        assertEquals(-1, t.getInputStream().read())
        assertEquals(0, ended.size)
    }
}
