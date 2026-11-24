// The app's one activity: the Capacitor bridge with the socket, stream and media plugins registered, the
// staged views served to their frame (`ViewFiles`), the media a view plays served to its player
// (`MediaFiles`, before the views), and the microphone handed to the page once the runtime
// permission is granted.
package com.fareaststudios.cophyla

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebChromeClient
import com.getcapacitor.BridgeWebViewClient

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CophylaSocketPlugin::class.java)
        registerPlugin(CophylaStreamPlugin::class.java)
        registerPlugin(CophylaMediaPlugin::class.java)
        super.onCreate(savedInstanceState)
        val host = bridge.host
        val views = ViewFiles(filesDir, host)
        val media = (bridge.getPlugin("CophylaMedia")?.instance as? CophylaMediaPlugin)?.media
        bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
            // off the UI thread: a media request may wait here for its first piece
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                media?.serve(request, host) ?: views.serve(request.method, request.url) ?: super.shouldInterceptRequest(view, request)

            // a page loaded afresh knows none of the streams the last one opened
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                media?.closeAll()
            }
        })
        // `getUserMedia` inside the page is granted once the app holds RECORD_AUDIO; the app asks for it as it starts listening
        bridge.webView.webChromeClient = object : BridgeWebChromeClient(bridge) {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (!wantsMic) {
                    super.onPermissionRequest(request)
                    return
                }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread { request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) }
                } else {
                    pendingMic = request
                    ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST)
                }
            }
        }
    }

    private var pendingMic: PermissionRequest? = null

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != MIC_REQUEST) return
        val request = pendingMic ?: return
        pendingMic = null
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        runOnUiThread { if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny() }
    }

    companion object {
        private const val MIC_REQUEST = 4818
    }
}
