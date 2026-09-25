// Serving the views staged under the app's storage to the sandboxed frame, as the desktop
// shell and the node do for theirs. Capacitor's own file server cannot: the frame has no
// `allow-same-origin`, so its document is on an opaque origin and a `<script type="module">`
// from it is a CORS fetch, which Capacitor answers with no `Access-Control-Allow-Origin`;
// and it types a file by Android's table, where `.ts` is `video/mp2t`, while a view's `.ts`
// files arrive type-stripped and are JavaScript. Only files under `files/views/` are served
// here; everything else goes on to Capacitor.
package com.fareaststudios.cophyla

import android.net.Uri
import android.webkit.WebResourceResponse
import com.getcapacitor.Bridge
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream

class ViewFiles(filesDir: File, private val host: String?) {
    private val dir: File = File(filesDir, "views")
    /** URLs name the directory as the Filesystem plugin does (`/data/user/0/…`), a symlink. */
    private val prefix: String = Bridge.CAPACITOR_FILE_START + dir.path + "/"
    /** Containment is checked on resolved paths, so `..` and links cannot leave it. */
    private val root: File = dir.canonicalFile

    /** The response for a staged view file, or null when the request is not for one. */
    fun serve(method: String, uri: Uri): WebResourceResponse? {
        if (method != "GET" || uri.host != host) return null
        val path = uri.path ?: return null
        if (!path.startsWith(prefix)) return null
        val file = File(dir, path.removePrefix(prefix)).canonicalFile
        if (!file.path.startsWith(root.path + File.separator) || !file.isFile) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", HEADERS, ByteArrayInputStream(ByteArray(0)))
        }
        val mime = MIME[file.extension.lowercase()] ?: "application/octet-stream"
        val encoding = if (mime.startsWith("text/") || mime == "application/json" || mime == "image/svg+xml") "utf-8" else null
        return WebResourceResponse(mime, encoding, 200, "OK", HEADERS, FileInputStream(file))
    }

    companion object {
        /** The node's table (`apps/cophylad/src/views/files.ts`), which is what a view is written against. */
        private val MIME = mapOf(
            "ts" to "text/javascript",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "html" to "text/html",
            "css" to "text/css",
            "json" to "application/json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "ico" to "image/x-icon",
            "woff2" to "font/woff2",
            "md" to "text/markdown",
            "txt" to "text/plain",
        )

        /** The frame's opaque origin may read what it was given; nothing is sniffed into another type. */
        private val HEADERS = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "X-Content-Type-Options" to "nosniff",
            "Cache-Control" to "no-cache",
        )
    }
}
