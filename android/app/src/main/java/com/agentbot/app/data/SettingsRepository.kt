package com.agentbot.app.data

import android.content.Context
import android.content.SharedPreferences

/** Server connection persisted in SharedPreferences; nothing else is stored. */
class SettingsRepository(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_BASE_URL, value).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    /** 可选的消息级加密配对密钥（base64，32 字节）；扫码配对时随二维码导入。 */
    var encKey: String
        get() = prefs.getString(KEY_ENC_KEY, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_ENC_KEY, value).apply()

    fun connection(): Connection? {
        if (baseUrl.isBlank() || token.isBlank()) return null
        return Connection(baseUrl, token, encKey.ifBlank { null })
    }

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_ENC_KEY = "enc_key"
    }
}
