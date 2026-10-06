package com.kvideo.tv

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.CustomViewCallback
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {

    companion object {
        private const val PREFS_NAME = "kvideo_tv_settings"
        private const val PREF_SERVER_URL = "server_url"
        private const val TAG = "KVideoMainActivity"
    }

    private lateinit var webView: WebView
    private lateinit var setupContainer: View
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var urlInput: DpadEditText
    private lateinit var statusText: TextView
    private lateinit var openButton: Button
    private lateinit var saveButton: Button
    private lateinit var prefs: android.content.SharedPreferences
    private var customView: View? = null
    private var customViewCallback: CustomViewCallback? = null
    private var wasSetupVisibleBeforeFullscreen = false

    /** True while the setup URL field is in edit mode (keyboard + cursor). */
    private var isEditingUrl = false

    /** Mirrors the web page's edit state so Back/D-pad can escape web inputs. */
    @Volatile
    private var isWebEditing = false

    /** WebView 文件选择回调：必须恰好回传一次（取消时回 null）。 */
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = pendingFileChooserCallback ?: return@registerForActivityResult
            pendingFileChooserCallback = null
            callback.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersiveMode()

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        setupContainer = findViewById(R.id.setup_container)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        urlInput = findViewById(R.id.url_input)
        statusText = findViewById(R.id.status_text)
        openButton = findViewById(R.id.open_button)
        saveButton = findViewById(R.id.save_button)

        saveButton.setOnClickListener {
            openConfiguredUrl()
        }

        // Confirm-step editing: D-pad focus only selects the field, OK opens
        // the keyboard, and Down/Back get out again without trapping the cursor.
        urlInput.showSoftInputOnFocus = false
        urlInput.isCursorVisible = false
        urlInput.keyInterceptor = { keyCode, action -> handleSetupKey(keyCode, action) }
        urlInput.setOnClickListener {
            if (!isEditingUrl) {
                enterUrlEditMode()
            }
        }
        urlInput.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus && isEditingUrl) {
                exitUrlEditMode()
            }
        }
        urlInput.setOnEditorActionListener { _, actionId, _ ->
            val isKeyboardConfirmAction = actionId == EditorInfo.IME_ACTION_DONE ||
                actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_SEND ||
                actionId == EditorInfo.IME_ACTION_NEXT ||
                actionId == EditorInfo.IME_NULL

            if (isKeyboardConfirmAction) {
                openConfiguredUrl()
                true
            } else {
                false
            }
        }

        webView.apply {
            setLayerType(View.LAYER_TYPE_HARDWARE, null)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                databaseEnabled = true
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    // 页面导航/reload 后 JS 侧的编辑态已丢失，复位原生标记，
                    // 否则第一次返回/方向键会被 dispatchKeyEvent 吞掉。
                    isWebEditing = false
                    super.onPageStarted(view, url, favicon)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    if (view == null || callback == null) {
                        callback?.onCustomViewHidden()
                        return
                    }

                    if (customView != null) {
                        callback.onCustomViewHidden()
                        return
                    }

                    wasSetupVisibleBeforeFullscreen = isSetupVisible()
                    customView = view
                    customViewCallback = callback

                    fullscreenContainer.removeAllViews()
                    fullscreenContainer.addView(
                        view,
                        FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    )
                    fullscreenContainer.visibility = View.VISIBLE
                    webView.visibility = View.GONE
                    setupContainer.visibility = View.GONE
                    applyImmersiveMode()
                }

                override fun onHideCustomView() {
                    exitCustomFullscreen()
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    // 契约：每次 onShowFileChooser 必须恰好回调一次
                    pendingFileChooserCallback?.onReceiveValue(null)
                    val callback = filePathCallback ?: return true
                    pendingFileChooserCallback = callback

                    val intent = fileChooserParams?.createIntent()
                        ?: Intent(Intent.ACTION_GET_CONTENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("*/*")

                    return try {
                        fileChooserLauncher.launch(intent)
                        true
                    } catch (error: ActivityNotFoundException) {
                        pendingFileChooserCallback = null
                        callback.onReceiveValue(null)
                        notifyFileChooserUnavailable()
                        true
                    } catch (error: Exception) {
                        Log.w(TAG, "Failed to launch file chooser", error)
                        pendingFileChooserCallback = null
                        callback.onReceiveValue(null)
                        true
                    }
                }
            }
            addJavascriptInterface(AndroidPlayerBridge(), "KVideoAndroid")
        }

        val configuredUrl = getConfiguredUrl()
        if (configuredUrl.isNotEmpty()) {
            urlInput.setText(configuredUrl)
            loadConfiguredUrl(configuredUrl)
        } else {
            showSetup(getString(R.string.status_first_launch))
        }
    }

    /**
     * While a web input is in edit mode the soft keyboard may swallow D-pad
     * keys — bridge them straight to the page so the cursor can always escape.
     */
    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event != null && !isSetupVisible() && isWebEditing) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_UP -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        val dir = if (event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) "down" else "up"
                        webView.evaluateJavascript(
                            "window.__kvideoTvNav && window.__kvideoTvNav('$dir')",
                            null
                        )
                    }
                    return true
                }
                KeyEvent.KEYCODE_BACK -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript(
                            "window.__kvideoExitEdit && window.__kvideoExitEdit()",
                            null
                        )
                        isWebEditing = false
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (!isSetupVisible() && keyCode == KeyEvent.KEYCODE_BACK && customView != null) {
            exitCustomFullscreen()
            return true
        }

        if (!isSetupVisible() && (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS)) {
            showSetup(getString(R.string.status_settings_hint))
            return true
        }

        // Map D-pad center to Enter for spatial navigation
        if (!isSetupVisible() && keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            webView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (!isSetupVisible() && keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            webView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    @Deprecated("Use OnBackPressedDispatcher")
    override fun onBackPressed() {
        if (customView != null) {
            exitCustomFullscreen()
            return
        }

        if (isSetupVisible()) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
            return
        }

        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            showSetup(getString(R.string.status_settings_hint))
        }
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            applyImmersiveMode()
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        dispatchPictureInPictureChange(isInPictureInPictureMode)
        if (!isInPictureInPictureMode) {
            applyImmersiveMode()
        }
    }

    override fun onDestroy() {
        exitCustomFullscreen()
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = null
        webView.destroy()
        super.onDestroy()
    }

    private fun openConfiguredUrl() {
        val normalizedUrl = normalizeUrl(urlInput.text.toString())
        if (!isValidUrl(normalizedUrl)) {
            statusText.text = getString(R.string.status_invalid_url)
            urlInput.requestFocus()
            return
        }

        prefs.edit().putString(PREF_SERVER_URL, normalizedUrl).apply()
        loadConfiguredUrl(normalizedUrl)
    }

    private fun loadConfiguredUrl(url: String) {
        isEditingUrl = false
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(urlInput.windowToken, 0)
        setupContainer.visibility = View.GONE
        statusText.text = getString(R.string.status_ready)
        webView.loadUrl(url)
    }

    /** Remote-key handling for the setup URL field (confirm-step edit mode). */
    private fun handleSetupKey(keyCode: Int, action: Int): Boolean {
        val isUp = action == KeyEvent.ACTION_UP

        return when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                if (!isEditingUrl) {
                    false
                } else {
                    if (isUp) exitUrlEditMode()
                    true
                }
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (isUp) {
                    if (isEditingUrl) exitUrlEditMode()
                    openButton.requestFocus()
                }
                true
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                if (isUp && isEditingUrl) exitUrlEditMode()
                true
            }
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (isUp) {
                    if (isEditingUrl) exitUrlEditMode() else enterUrlEditMode()
                }
                true
            }
            else -> false
        }
    }

    private fun enterUrlEditMode() {
        if (isEditingUrl) return
        isEditingUrl = true
        urlInput.isCursorVisible = true
        urlInput.setSelection(urlInput.text?.length ?: 0)
        statusText.text = getString(R.string.status_editing_hint)
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(urlInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun exitUrlEditMode() {
        if (!isEditingUrl) return
        isEditingUrl = false
        urlInput.isCursorVisible = false
        statusText.text = getString(R.string.status_select_hint)
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(urlInput.windowToken, 0)
    }

    private fun showSetup(message: String) {
        val currentUrl = getConfiguredUrl()
        if (currentUrl.isNotEmpty() && urlInput.text.toString().isBlank()) {
            urlInput.setText(currentUrl)
        }

        if (currentUrl.isNotEmpty()) {
            openButton.text = getString(R.string.button_open_saved)
            openButton.setOnClickListener {
                urlInput.setText(currentUrl)
                loadConfiguredUrl(currentUrl)
            }
        } else {
            openButton.text = getString(R.string.button_exit)
            openButton.setOnClickListener {
                finish()
            }
        }

        statusText.text = message
        setupContainer.visibility = View.VISIBLE
        isEditingUrl = false
        urlInput.isCursorVisible = false
        urlInput.requestFocus()
    }

    private fun getConfiguredUrl(): String {
        val savedUrl = prefs.getString(PREF_SERVER_URL, null)?.trim().orEmpty()
        if (isValidUrl(savedUrl)) {
            return savedUrl
        }

        val defaultUrl = normalizeUrl(BuildConfig.DEFAULT_KVIDEO_URL)
        return if (isValidUrl(defaultUrl)) defaultUrl else ""
    }

    private fun isSetupVisible(): Boolean = setupContainer.visibility == View.VISIBLE

    private fun normalizeUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) {
            return ""
        }

        val withScheme = if (
            trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            trimmed
        } else {
            "https://$trimmed"
        }

        return withScheme.removeSuffix("/")
    }

    private fun isValidUrl(url: String): Boolean {
        if (url.isBlank()) {
            return false
        }

        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        return (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
    }

    private fun applyImmersiveMode() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        )
    }

    private fun exitCustomFullscreen() {
        val currentCustomView = customView ?: return
        fullscreenContainer.removeView(currentCustomView)
        fullscreenContainer.visibility = View.GONE
        customView = null
        webView.visibility = View.VISIBLE
        if (wasSetupVisibleBeforeFullscreen) {
            setupContainer.visibility = View.VISIBLE
        }
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        wasSetupVisibleBeforeFullscreen = false
        applyImmersiveMode()
    }

    private fun isPictureInPictureSupported(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return false
        }

        return packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
    }

    private fun notifyFileChooserUnavailable() {
        val js = "window.dispatchEvent(new CustomEvent('kvideo-file-chooser-unavailable'))"
        webView.post {
            try {
                webView.evaluateJavascript(js, null)
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to dispatch file-chooser-unavailable event", error)
            }
        }
    }

    private fun dispatchPictureInPictureChange(isInPictureInPictureMode: Boolean) {
        val js = """
            window.dispatchEvent(new CustomEvent('kvideo-android-pip-change', {
                detail: { inPictureInPicture: ${if (isInPictureInPictureMode) "true" else "false"} }
            }));
        """.trimIndent()

        webView.post {
            try {
                webView.evaluateJavascript(js, null)
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to dispatch Picture-in-Picture change event", error)
            }
        }
    }

    private fun createSourceRectHint(left: Int, top: Int, right: Int, bottom: Int): Rect? {
        if (right <= left || bottom <= top) {
            return null
        }

        val density = resources.displayMetrics.density
        return Rect(
            (left * density).roundToInt(),
            (top * density).roundToInt(),
            (right * density).roundToInt(),
            (bottom * density).roundToInt()
        )
    }

    private inner class AndroidPlayerBridge {
        @JavascriptInterface
        fun setWebEditing(editing: Boolean) {
            isWebEditing = editing
        }

        @JavascriptInterface
        fun isPictureInPictureSupported(): Boolean = this@MainActivity.isPictureInPictureSupported()

        @JavascriptInterface
        fun enterPictureInPicture(
            width: Int,
            height: Int,
            left: Int,
            top: Int,
            right: Int,
            bottom: Int
        ): Boolean {
            if (!this@MainActivity.isPictureInPictureSupported()) {
                return false
            }

            val didEnterPiP = AtomicBoolean(false)
            val latch = CountDownLatch(1)

            runOnUiThread {
                try {
                    val builder = android.app.PictureInPictureParams.Builder()
                    if (width > 0 && height > 0) {
                        builder.setAspectRatio(Rational(width, height))
                    }
                    createSourceRectHint(left, top, right, bottom)?.let(builder::setSourceRectHint)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        builder.setSeamlessResizeEnabled(true)
                    }
                    didEnterPiP.set(enterPictureInPictureMode(builder.build()))
                } catch (error: IllegalStateException) {
                    Log.w(TAG, "Failed to enter Picture-in-Picture mode", error)
                } finally {
                    latch.countDown()
                }
            }

            return try {
                latch.await(1500, TimeUnit.MILLISECONDS)
                didEnterPiP.get()
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.w(TAG, "Interrupted while waiting for Picture-in-Picture result", error)
                false
            }
        }
    }
}
