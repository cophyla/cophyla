// The page's side of streamed media (MediaFiles): `open` makes a stream before the player is
// given its URL (`https://<bridge.host>/_cophyla_media/<id>/<name>`), `close` ends it, `stats`
// says what it served. While the player reads, a `need` event asks the page for a piece the
// cache lacks (`req`, `id`, `index`, `at`, `len`), and `piece` answers it with the bytes in
// base64 or the reason they did not come. The plugin owns the one MediaFiles of the app;
// MainActivity hands the player's requests to it.
package com.fareaststudios.cophyla

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

@CapacitorPlugin(name = "CophylaMedia")
class CophylaMediaPlugin : Plugin() {
    /** The range server and its cache, made as the bridge loads the plugin. */
    lateinit var media: MediaFiles
        private set

    override fun load() {
        media = MediaFiles(
            File(context.cacheDir, "media-cache"),
            MediaFiles.Needs { req, id, index, at, len ->
                notifyListeners("need", JSObject().put("req", req).put("id", id).put("index", index).put("at", at).put("len", len))
            },
        )
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val key = call.getString("key") ?: return call.reject("key required")
        val size = whole(call, "size") ?: return call.reject("size required")
        val mime = call.getString("mime") ?: return call.reject("mime required")
        val keep = call.getBoolean("keep", false) ?: false
        try {
            media.open(id, key, size, mime, keep)
        } catch (e: IllegalArgumentException) {
            return call.reject(e.message ?: "that stream cannot be opened")
        }
        call.resolve()
    }

    @PluginMethod
    fun piece(call: PluginCall) {
        val req = whole(call, "req") ?: return call.reject("req required")
        val data = call.getString("data")
        if (data == null) {
            media.piece(req, null, call.getString("error"))
            return call.resolve()
        }
        val bytes = try {
            Base64.decode(data, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            // the request waiting on it fails now rather than at the timeout
            media.piece(req, null, "the piece was not base64")
            return call.reject("data is not base64")
        }
        media.piece(req, bytes, null)
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        media.close(id)
        call.resolve()
    }

    @PluginMethod
    fun stats(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val stats = media.stats(id) ?: return call.reject("no stream $id")
        call.resolve(JSObject().put("requests", stats.requests).put("fetched", stats.fetched).put("cached", stats.cached))
    }

    override fun handleOnDestroy() {
        if (::media.isInitialized) media.shutdown()
    }

    /** A whole number argument: the bridge hands a JS number over as an Integer, a Long or a Double by its size. */
    private fun whole(call: PluginCall, name: String): Long? {
        val v = call.data.opt(name) as? Number ?: return null
        if (v is Double || v is Float) {
            val d = v.toDouble()
            if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || Math.abs(d) > MAX_SAFE) return null
        }
        return v.toLong()
    }

    companion object {
        /** The largest whole number a JS number holds exactly. */
        private const val MAX_SAFE = 9007199254740991.0
    }
}
