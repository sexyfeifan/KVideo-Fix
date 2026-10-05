# Keep the WebView JS bridge: these methods are called from the web page
# via window.KVideoAndroid and would be stripped by minification otherwise.
-keepclassmembers class com.kvideo.tv.MainActivity$AndroidPlayerBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.kvideo.tv.DpadEditText { *; }
