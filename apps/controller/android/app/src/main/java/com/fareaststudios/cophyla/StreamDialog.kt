// The remote desktop on the phone's screen: a full-screen dialog over the app's own activity,
// not an activity of its own, so the app never goes to the background and its link to the
// node stays up while the stream shows. Its web view is its own, with no bridge into the
// app: it loads the stream page from the forwarder's loopback origin and nothing else (a link
// elsewhere goes to the browser), is refused every permission it asks for, and keeps the
// screen on with the system bars hidden until swiped in. "×" ends the stream; Back asks
// first. On the way out the web view is destroyed and the stream's cookie and storage go.
package com.fareaststudios.cophyla

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class StreamDialog(
    private val activity: Activity,
    /** `http://127.0.0.1:<port>`: the forwarder's, and the only origin this web view loads. */
    private val origin: String,
    private val path: String,
    private val onClosed: (reason: String) -> Unit,
) : Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
    private var web: WebView? = null

    /** Why the stream ended, said once the dialog is gone: `closed` unless something else ended it. */
    var reason = "closed"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(context)
        root.setBackgroundColor(Color.BLACK)
        val view = WebView(context)
        configure(view)
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(closeButton(), FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP or Gravity.END))
        setContentView(root)
        web = view
        window?.let { w ->
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
            immersive()
        }
        setOnDismissListener { cleanup() }
        view.loadUrl(origin + path)
    }

    private fun configure(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            // the stream page keeps its settings in local storage
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (sameOrigin(request.url)) return false
                val scheme = request.url.scheme
                if (request.isForMainFrame && (scheme == "http" || scheme == "https")) {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (e: Exception) {
                        // no browser: the link goes nowhere
                    }
                }
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // the page's renderer died: this web view is unusable, so the stream ends
                reason = "the stream page stopped"
                dismiss()
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)
            }
        }
    }

    private fun sameOrigin(url: Uri): Boolean {
        val here = Uri.parse(origin)
        return url.scheme == here.scheme && url.host == here.host && url.port == here.port
    }

    private fun closeButton(): TextView =
        TextView(context).apply {
            text = "×"
            contentDescription = "End the remote desktop"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            gravity = Gravity.CENTER
            alpha = 0.55f
            setBackgroundColor(Color.argb(90, 0, 0, 0))
            setOnClickListener { dismiss() }
        }

    // the app does not opt into predictive back, so Back still lands here
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        AlertDialog.Builder(activity)
            .setMessage("End the remote desktop?")
            .setPositiveButton("End") { _, _ -> dismiss() }
            .setNegativeButton("Keep watching", null)
            .show()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // the question over the stream brought the bars back
        if (hasFocus) immersive()
    }

    private fun immersive() {
        val w = window ?: return
        WindowCompat.setDecorFitsSystemWindows(w, false)
        WindowInsetsControllerCompat(w, w.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun cleanup() {
        web?.let { view ->
            view.stopLoading()
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        }
        web = null
        // the session cookie is dead on the node already once the stream is closed; it goes here too, and the page's storage with it
        val cookies = CookieManager.getInstance()
        cookies.setCookie(origin, "cophyla_remote=; Path=/remote; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        cookies.flush()
        WebStorage.getInstance().deleteOrigin(origin)
        onClosed(reason)
    }

    private fun dp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics).toInt()
}
