// A port of one of the user's machines on the phone's screen: a full-screen dialog over the
// app's own activity, as the remote desktop's is, so the app's link stays up while it shows. A
// thin bar names what is open (`localhost:3000 · Desk`) with Back, Reload and "×"; under it a
// web view of its own, with no bridge into the app, loads the page from the port forwarder on
// the phone's loopback and stays on that origin, `localhost` or `127.0.0.1` at its port (a link
// elsewhere goes to the browser, so an outside sign-in whose callback names localhost fails
// there), and is refused every permission it asks for. Before the page loads, the forwarder's
// secret is set as a cookie for both names of the origin, which every connection's first
// request brings; on the way out that cookie goes and the web view is destroyed, while the
// site's own cookies and storage stay, so its sign-ins are there next time.
package com.fareaststudios.cophyla

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

class PortDialog(
    private val activity: Activity,
    /** The port the page is reached at on the phone: the forwarder's. */
    private val local: Int,
    /** The machine's port, and its name, for the bar. */
    private val port: Int,
    private val name: String,
    /** The forwarder's cookie, which the page's requests must carry. */
    private val cookieName: String,
    private val secret: String,
    private val onClosed: (reason: String) -> Unit,
) : Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
    private var web: WebView? = null
    private var notice: TextView? = null

    /** Why the page closed, said once the dialog is gone: `closed` unless something else ended it. */
    var reason = "closed"

    /** Both names of the page's origin; the page loads from the first. */
    private val origins = listOf("http://localhost:$local", "http://127.0.0.1:$local")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
        }
        root.addView(bar(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)))
        val body = FrameLayout(context)
        val view = WebView(context)
        configure(view)
        body.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val words = TextView(context).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
            setBackgroundColor(BACKGROUND)
            visibility = View.GONE
        }
        body.addView(words, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        web = view
        notice = words
        window?.let { w ->
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT }
        }
        setOnDismissListener { cleanup() }
        // the secret first, for both names of the origin; the page once both are set
        val cookies = CookieManager.getInstance()
        var left = origins.size
        for (origin in origins) {
            cookies.setCookie(origin, "$cookieName=$secret; Path=/; HttpOnly; SameSite=Lax") {
                left--
                if (left == 0) web?.loadUrl("${origins[0]}/")
            }
        }
    }

    /** Says why the page cannot show, over it: a TLS server answered. */
    fun notice(text: String) {
        val words = notice ?: return
        words.text = text
        words.visibility = View.VISIBLE
    }

    private fun bar(): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(BAR)
            addView(button("‹", "Back") { web?.let { if (it.canGoBack()) it.goBack() } }, LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT))
            val title = TextView(context).apply {
                text = if (name.isBlank()) "localhost:$port" else "localhost:$port · $name"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                typeface = Typeface.DEFAULT_BOLD
                isSingleLine = true
                ellipsize = TextUtils.TruncateAt.END
                gravity = Gravity.CENTER_VERTICAL
            }
            addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
            addView(button("↻", "Reload") {
                notice?.visibility = View.GONE
                web?.reload()
            }, LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(button("×", "Close the page") { dismiss() }, LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT))
        }

    private fun button(label: String, description: String, onClick: () -> Unit): TextView =
        TextView(context).apply {
            text = label
            contentDescription = description
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            gravity = Gravity.CENTER
            setOnClickListener { onClick() }
        }

    private fun configure(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // a desktop's page on a phone: it may be pinched
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (here(request.url)) return false
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
                // the page's renderer died: this web view is unusable, so the page closes
                reason = "the page stopped"
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

    /** The page's own origin, by either of its names. */
    private fun here(url: Uri): Boolean = url.scheme == "http" && (url.host == "localhost" || url.host == "127.0.0.1") && url.port == local

    // the app does not opt into predictive back, so Back still lands here: the page's own history first
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        val view = web
        if (view != null && view.canGoBack()) view.goBack() else dismiss()
    }

    private fun cleanup() {
        web?.let { view ->
            view.stopLoading()
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        }
        web = null
        notice = null
        // the secret is this opening's alone; the site's own cookies and storage stay for the next
        val cookies = CookieManager.getInstance()
        for (origin in origins) cookies.setCookie(origin, "$cookieName=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        cookies.flush()
        onClosed(reason)
    }

    private fun dp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics).toInt()

    companion object {
        private val BACKGROUND = Color.rgb(0x14, 0x12, 0x1a)
        private val BAR = Color.rgb(0x22, 0x1f, 0x2b)
    }
}
