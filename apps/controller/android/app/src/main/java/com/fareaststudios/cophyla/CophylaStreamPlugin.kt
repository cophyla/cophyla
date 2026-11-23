// The remote desktop, as the page asks for it: `open` starts a forwarder on loopback and
// shows the stream page in its dialog; `close` ends it; a `closed` event says every way one
// ends (the user, the key changing under it, the page's renderer, another stream opening), so
// the page can tell the node and bring the microphone back. One stream shows at a time. On
// the LAN (`host`, `port`, `pin`) the node's key is checked with one handshake first and the
// connections go over pinned sockets; over the link (`link`) they become pipes the page
// carries: a `pipe` event asks it for one, `pipeData` hands it what the web view sent,
// `written` what reached the web view, `pipeEnd` a connection closed here; `pipeOpened`,
// `pipeFailed`, `pipeWrite`, `pipeAck` and `pipeClose` are its side.
//
// A port of one of the user's machines shows the same way, beside it: `openPort` starts a
// port forwarder on loopback and shows the machine's page in its dialog, answering the port it
// listens on here; `closePort` ends it; `portClosed` says every way one ends. One page shows
// at a time. Its connections are always pipes: `portPipe` asks the page for one, and the rest
// of the pipe events and calls above serve them too, since a page's connections are named
// apart from a stream's (`q…`, a stream's `k…`). A TLS server's answer is not handed to the
// page: the dialog says HTTPS pages do not open here yet.
package com.fareaststudios.cophyla

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "CophylaStream")
class CophylaStreamPlugin : Plugin() {
    private class Current(val stream: String, val forwarder: StreamForwarder, val dialog: StreamDialog, val pipes: PipeBackend?)

    /** The stream on the screen; touched on the main thread only. */
    private var current: Current? = null

    /** The link backend of the stream showing, for the pipe calls, which come on the plugin's threads. */
    @Volatile
    private var pipes: PipeBackend? = null

    private class Port(val id: String, val forwarder: PortForwarder, val dialog: PortDialog, val pipes: PipeBackend)

    /** The port's page on the screen; touched on the main thread only. */
    private var port: Port? = null

    /** The backend of the page showing, for the pipe calls of its connections. */
    @Volatile
    private var portPipes: PipeBackend? = null

    /** The backend a connection is of: a page's or the stream's, by how its id starts. */
    private fun backendOf(conn: String): PipeBackend? = if (conn.startsWith(PORT_CONN)) portPipes else pipes

    @PluginMethod
    fun open(call: PluginCall) {
        val stream = call.getString("stream")?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return call.reject("stream required")
        val path = call.getString("path") ?: return call.reject("path required")
        if (!path.startsWith("/remote/") || path.length > 2048 || path.any { it <= ' ' || it.code > 126 }) return call.reject("that stream page cannot be opened")
        if (call.getBoolean("link", false) == true) {
            val backend = PipeBackend(pipeEvents(stream))
            show(call, stream, path, backend, backend)
            return
        }
        val host = call.getString("host")?.takeIf { it.isNotEmpty() } ?: return call.reject("host required")
        val port = call.getInt("port")?.takeIf { it in 1..65535 } ?: return call.reject("port required")
        val pin = call.getString("pin")?.takeIf { it.isNotEmpty() } ?: return call.reject("pin required")
        Thread({
            val backend = LanBackend(host, port, pin) { reason -> activity.runOnUiThread { end(stream, reason) } }
            try {
                backend.probe()
            } catch (e: Exception) {
                call.reject(if (PinnedTls.isPinMismatch(e)) PinnedTls.PIN_MISMATCH else "the node did not answer: ${e.message ?: e.javaClass.simpleName}")
                return@Thread
            }
            show(call, stream, path, backend, null)
        }, "cophyla-stream-open").start()
    }

    /** Starts the forwarder and shows the dialog on it. */
    private fun show(call: PluginCall, stream: String, path: String, backend: StreamForwarder.Backend, pipes: PipeBackend?) {
        val forwarder = try {
            StreamForwarder(backend)
        } catch (e: Exception) {
            call.reject("no loopback port for the stream: ${e.message}")
            return
        }
        activity.runOnUiThread {
            current?.let { end(it.stream, "replaced") }
            this.pipes = pipes
            forwarder.start()
            val dialog = StreamDialog(activity, "http://127.0.0.1:${forwarder.port}", path) { reason -> closed(stream, reason) }
            current = Current(stream, forwarder, dialog, pipes)
            dialog.show()
            call.resolve()
        }
    }

    private fun pipeEvents(stream: String) = object : PipeBackend.Events {
        override fun connection(conn: String) {
            notifyListeners("pipe", JSObject().put("stream", stream).put("conn", conn))
        }

        override fun data(conn: String, bytes: ByteArray) {
            notifyListeners("pipeData", JSObject().put("conn", conn).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }

        override fun written(conn: String, bytes: Int) {
            notifyListeners("written", JSObject().put("conn", conn).put("bytes", bytes))
        }

        override fun ended(conn: String, reason: String) {
            notifyListeners("pipeEnd", JSObject().put("conn", conn).put("reason", reason))
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val stream = call.getString("stream") ?: return call.reject("stream required")
        activity.runOnUiThread {
            end(stream, "closed")
            call.resolve()
        }
    }

    // --- the page's side of the pipes -------------------------------------------------------------

    @PluginMethod
    fun pipeOpened(call: PluginCall) {
        val conn = call.getString("conn") ?: return call.reject("conn required")
        val window = call.getInt("window")?.takeIf { it > 0 } ?: return call.reject("window required")
        call.resolve(JSObject().put("open", backendOf(conn)?.opened(conn, window) ?: false))
    }

    @PluginMethod
    fun pipeFailed(call: PluginCall) {
        val conn = call.getString("conn") ?: return call.reject("conn required")
        backendOf(conn)?.failed(conn)
        call.resolve()
    }

    @PluginMethod
    fun pipeWrite(call: PluginCall) {
        val conn = call.getString("conn") ?: return call.reject("conn required")
        val data = call.getString("data") ?: return call.reject("data required")
        val bytes = try {
            Base64.decode(data, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            return call.reject("data is not base64")
        }
        backendOf(conn)?.write(conn, bytes)
        call.resolve()
    }

    @PluginMethod
    fun pipeAck(call: PluginCall) {
        val conn = call.getString("conn") ?: return call.reject("conn required")
        val bytes = call.getInt("bytes")?.takeIf { it > 0 } ?: return call.reject("bytes required")
        backendOf(conn)?.ack(conn, bytes)
        call.resolve()
    }

    @PluginMethod
    fun pipeClose(call: PluginCall) {
        val conn = call.getString("conn") ?: return call.reject("conn required")
        backendOf(conn)?.close(conn)
        call.resolve()
    }

    // --- a port's page ----------------------------------------------------------------------------

    @PluginMethod
    fun openPort(call: PluginCall) {
        val id = call.getString("id")?.takeIf { PORT_ID.matches(it) } ?: return call.reject("id required")
        val number = call.getInt("port")?.takeIf { it in 1..65535 } ?: return call.reject("port required")
        val name = (call.getString("name") ?: "").trim().take(NAME_MAX)
        val backend = PipeBackend(portEvents(id), prefix = PORT_CONN, firstDown = { bytes ->
            val tls = PortForwarder.looksLikeTls(bytes)
            if (tls) activity.runOnUiThread { port?.takeIf { it.id == id }?.dialog?.notice(HTTPS_REFUSED) }
            !tls
        })
        val forwarder = try {
            PortForwarder(number, id, backend)
        } catch (e: Exception) {
            return call.reject("no loopback port for the page: ${e.message}")
        }
        activity.runOnUiThread {
            port?.let { endPort(it.id, "replaced") }
            portPipes = backend
            forwarder.start()
            val dialog = PortDialog(activity, forwarder.port, number, name, forwarder.cookieName, forwarder.secret) { reason -> portClosed(id, reason) }
            port = Port(id, forwarder, dialog, backend)
            dialog.show()
            call.resolve(JSObject().put("local", forwarder.port))
        }
    }

    private fun portEvents(id: String) = object : PipeBackend.Events {
        override fun connection(conn: String) {
            notifyListeners("portPipe", JSObject().put("port", id).put("conn", conn))
        }

        override fun data(conn: String, bytes: ByteArray) {
            notifyListeners("pipeData", JSObject().put("conn", conn).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }

        override fun written(conn: String, bytes: Int) {
            notifyListeners("written", JSObject().put("conn", conn).put("bytes", bytes))
        }

        override fun ended(conn: String, reason: String) {
            notifyListeners("pipeEnd", JSObject().put("conn", conn).put("reason", reason))
        }
    }

    @PluginMethod
    fun closePort(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        activity.runOnUiThread {
            endPort(id, "closed")
            call.resolve()
        }
    }

    /** Ends the page of `id` if it is the one showing; `portClosed` follows from the dialog's dismissal. */
    private fun endPort(id: String, reason: String) {
        val p = port ?: return
        if (p.id != id) return
        port = null
        releasePort(p)
        p.dialog.reason = reason
        p.dialog.dismiss()
    }

    /** The dialog is gone, by `endPort` or by its own "×" or Back. */
    private fun portClosed(id: String, reason: String) {
        val p = port
        if (p != null && p.id == id) {
            port = null
            releasePort(p)
        }
        notifyListeners("portClosed", JSObject().put("id", id).put("reason", reason))
    }

    private fun releasePort(p: Port) {
        p.forwarder.close()
        p.pipes.closeAll()
        if (portPipes === p.pipes) portPipes = null
    }

    // --- ends -------------------------------------------------------------------------------------

    /** Ends `stream` if it is the one showing: its connections are cut now, and `closed` follows from the dialog's dismissal, which Android posts. */
    private fun end(stream: String, reason: String) {
        val c = current ?: return
        if (c.stream != stream) return
        current = null
        release(c)
        c.dialog.reason = reason
        c.dialog.dismiss()
    }

    /** The dialog is gone, by `end` or by its own "×" or Back. */
    private fun closed(stream: String, reason: String) {
        val c = current
        if (c != null && c.stream == stream) {
            current = null
            release(c)
        }
        notifyListeners("closed", JSObject().put("stream", stream).put("reason", reason))
    }

    private fun release(c: Current) {
        c.forwarder.close()
        c.pipes?.closeAll()
        if (pipes === c.pipes) pipes = null
    }

    override fun handleOnDestroy() {
        current?.let {
            release(it)
            it.dialog.dismiss()
        }
        current = null
        port?.let {
            releasePort(it)
            it.dialog.dismiss()
        }
        port = null
    }

    companion object {
        /** What a port's page's connections are named by: never a stream's. */
        const val PORT_CONN = "q"
        private const val NAME_MAX = 100
        private val PORT_ID = Regex("^prt_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        const val HTTPS_REFUSED = "HTTPS dev servers don't open on the phone yet"
    }
}
