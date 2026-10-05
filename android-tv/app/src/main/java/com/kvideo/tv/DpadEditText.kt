package com.kvideo.tv

import android.content.Context
import android.util.AttributeSet
import android.view.KeyEvent
import android.widget.EditText

/**
 * EditText that lets the host intercept remote keys before the IME consumes
 * them, so a D-pad never gets trapped inside the text cursor.
 *
 * The interceptor receives (keyCode, keyAction) and returns true to consume.
 */
class DpadEditText @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.editTextStyle
) : EditText(context, attrs, defStyleAttr) {

    var keyInterceptor: ((keyCode: Int, action: Int) -> Boolean)? = null

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent?): Boolean {
        val action = event?.action ?: return super.onKeyPreIme(keyCode, event)
        if (keyInterceptor?.invoke(keyCode, action) == true) {
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val action = event?.action ?: return super.onKeyDown(keyCode, event)
        if (keyInterceptor?.invoke(keyCode, action) == true) {
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        val action = event?.action ?: return super.onKeyUp(keyCode, event)
        if (keyInterceptor?.invoke(keyCode, action) == true) {
            return true
        }
        return super.onKeyUp(keyCode, event)
    }
}
