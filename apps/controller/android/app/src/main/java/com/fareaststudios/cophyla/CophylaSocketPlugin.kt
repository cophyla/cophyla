// The LAN socket the page cannot open itself: a WebSocket to the node's self-signed
// listener, trusted by the key it pins rather than by a certificate authority (`PinnedTls`).
// At pairing (no pin) any self-signed leaf is accepted and the SPKI hash of its key is
// reported in the `open` event, so the page can keep it; from then on a socket is opened
// with that hash as the pin and a leaf whose key differs is refused with `pin_mismatch` —
// never accepted on the quiet. Several sockets may be open at once (a probe beside the
// connection), told apart by the id the page gives each.
package com.fareaststudios.cophyla

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "CophylaSocket")
class CophylaSocketPlugin : Plugin() {
    private val sockets = ConcurrentHashMap<String, WebSocket>()

    private fun clientFor(trust: LeafTrust): OkHttpClient =
        OkHttpClient.Builder()
            .sslSocketFactory(PinnedTls.context(trust).socketFactory, trust)
            // the node's certificate names its addresses, but a phone may reach it by another: the key is what is trusted
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()

    @PluginMethod
    fun attach(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val url = call.getString("url") ?: return call.reject("url required")
        val pin = call.getString("pin")
        sockets.remove(id)?.close(1000, "replaced")
        val trust = LeafTrust(pin)
        val client = clientFor(trust)
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val data = JSObject().put("id", id).put("state", "open")
                if (pin == null) trust.seenSpki?.let { data.put("spki", it) }
                notifyListeners("state", data)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                notifyListeners("frame", JSObject().put("id", id).put("frame", text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (sockets.remove(id, webSocket)) notifyListeners("state", JSObject().put("id", id).put("state", "closed").put("code", code).put("reason", reason))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets.remove(id, webSocket)
                val reason = if (PinnedTls.isPinMismatch(t)) PinnedTls.PIN_MISMATCH else (t.message ?: t.javaClass.simpleName)
                notifyListeners("state", JSObject().put("id", id).put("state", "error").put("code", 1006).put("reason", reason))
            }
        }
        val ws = client.newWebSocket(Request.Builder().url(url).build(), listener)
        sockets[id] = ws
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val frame = call.getString("frame") ?: return call.reject("frame required")
        val ws = sockets[id] ?: return call.reject("no socket $id")
        if (!ws.send(frame)) return call.reject("socket $id is closing")
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val code = call.getInt("code") ?: 1000
        val reason = call.getString("reason") ?: ""
        val ws = sockets.remove(id)
        if (ws != null) {
            ws.close(if (code in 1000..4999) code else 1000, reason.take(120))
            notifyListeners("state", JSObject().put("id", id).put("state", "closed").put("code", code).put("reason", reason))
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        for ((_, ws) in sockets) ws.close(1001, "app closing")
        sockets.clear()
    }
}
