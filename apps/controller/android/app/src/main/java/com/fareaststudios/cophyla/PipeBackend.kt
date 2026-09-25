// The link backend, for a stream off the node's Wi-Fi: each connection the dialog's web view
// opens becomes a pipe over the app's link to the node whose desktop it shows. The page opens
// the pipe (`remote.pipe.open`) when told of the connection and carries its bytes as
// `remote.pipe.*`; this side reads from the web view only as far as the pipe's window allows,
// the credit coming back with the node's acks, and writes what comes down in order on one
// writer per connection, reporting each write so the page acknowledges it to the node. A
// connection whose pipe does not open in time, or fails to, is closed.
package com.fareaststudios.cophyla

import java.io.IOException
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class PipeBackend(private val events: Events, private val openTimeoutMs: Long = OPEN_TIMEOUT_MS) : StreamForwarder.Backend {
    /** What the page hears, on whatever thread it happens. */
    interface Events {
        /** A connection wants a pipe: answer with `opened` or `failed`. */
        fun connection(conn: String)
        /** Bytes read from the connection, within the pipe's window. */
        fun data(conn: String, bytes: ByteArray)
        /** Bytes written to the connection. */
        fun written(conn: String, bytes: Int)
        /** The connection closed on this side. */
        fun ended(conn: String, reason: String)
    }

    private class Conn(val id: String, val socket: Socket, val done: () -> Unit) {
        val lock = Object()
        /** Bytes the node may still take unacknowledged. */
        var credit = 0L
        @Volatile var opened = false
        @Volatile var closed = false
        val writer: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "cophyla-pipe-write").apply { isDaemon = true } }
    }

    private val conns = ConcurrentHashMap<String, Conn>()
    private val seq = AtomicInteger(0)

    /** Connections open now. */
    val count: Int get() = conns.size

    override fun serve(conn: Socket, head: ByteArray, done: () -> Unit) {
        val c = Conn("k${seq.incrementAndGet()}", conn, done)
        conns[c.id] = c
        events.connection(c.id)
        synchronized(c.lock) {
            val deadline = System.currentTimeMillis() + openTimeoutMs
            while (!c.opened && !c.closed) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) break
                c.lock.wait(left)
            }
            if (!c.opened) c.closed = true
        }
        if (!c.opened) {
            shut(c)
            return
        }
        send(c, head, head.size)
        val buf = ByteArray(CHUNK)
        val input = try {
            conn.getInputStream()
        } catch (e: IOException) {
            end(c, "the connection failed")
            return
        }
        try {
            while (true) {
                val room = synchronized(c.lock) {
                    while (c.credit <= 0 && !c.closed) c.lock.wait()
                    if (c.closed) -1L else c.credit
                }
                if (room < 0) return
                val n = input.read(buf, 0, minOf(buf.size.toLong(), room).toInt())
                if (n < 0) {
                    end(c, "the page closed it")
                    return
                }
                send(c, buf, n)
            }
        } catch (e: IOException) {
            end(c, "the connection failed")
        } catch (e: InterruptedException) {
            end(c, "stopped")
        }
    }

    private fun send(c: Conn, bytes: ByteArray, n: Int) {
        if (n <= 0) return
        synchronized(c.lock) { c.credit -= n }
        events.data(c.id, bytes.copyOf(n))
    }

    // --- from the page ----------------------------------------------------------------------------

    /** The pipe opened, with the window the node allows; false when the connection is gone meanwhile, and the pipe should close. */
    fun opened(conn: String, window: Int): Boolean {
        val c = conns[conn] ?: return false
        synchronized(c.lock) {
            if (c.closed) return false
            c.credit = window.toLong()
            c.opened = true
            c.lock.notifyAll()
        }
        return true
    }

    /** No pipe for it: the connection closes. */
    fun failed(conn: String) {
        val c = conns[conn] ?: return
        synchronized(c.lock) {
            c.closed = true
            c.lock.notifyAll()
        }
    }

    /** Bytes the node sent, written in order; each write is reported. */
    fun write(conn: String, bytes: ByteArray) {
        val c = conns[conn] ?: return
        try {
            c.writer.execute {
                if (c.closed) return@execute
                try {
                    c.socket.getOutputStream().apply {
                        write(bytes)
                        flush()
                    }
                    events.written(c.id, bytes.size)
                } catch (e: IOException) {
                    end(c, "writing to the page failed")
                }
            }
        } catch (e: Exception) {
            // the writer is gone: the connection with it
        }
    }

    /** The node took `bytes` of what this side sent. */
    fun ack(conn: String, bytes: Int) {
        val c = conns[conn] ?: return
        synchronized(c.lock) {
            c.credit += bytes
            c.lock.notifyAll()
        }
    }

    /** The node closed the pipe: the connection closes once what was written before it is out. */
    fun close(conn: String) {
        val c = conns[conn] ?: return
        try {
            c.writer.execute { shut(c) }
        } catch (e: Exception) {
            shut(c)
        }
    }

    /** The stream ended: every connection closes. */
    fun closeAll() {
        for (c in conns.values) shut(c)
    }

    // --- ends -------------------------------------------------------------------------------------

    /** Closed on this side: the page is told, so the node is. */
    private fun end(c: Conn, reason: String) {
        if (!shut(c)) return
        events.ended(c.id, reason)
    }

    /** Closes it once; whether this call did. */
    private fun shut(c: Conn): Boolean {
        synchronized(c.lock) {
            c.closed = true
            c.lock.notifyAll()
        }
        if (conns.remove(c.id) == null) return false
        c.writer.shutdown()
        StreamForwarder.closeQuietly(c.socket)
        c.done()
        return true
    }

    companion object {
        const val OPEN_TIMEOUT_MS = 15_000L
        /** The most one read sends: the node's chunk. */
        const val CHUNK = 48 * 1024
    }
}
