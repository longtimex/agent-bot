package com.agentbot.app.widget

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.agentbot.app.MainActivity
import com.agentbot.app.R
import java.security.SecureRandom

/**
 * The ways into the App from outside it: the home-screen widget, the Quick Settings tile and the
 * launcher's long-press shortcuts all open MainActivity with one of these entries.
 *
 * MainActivity is exported (it receives shares), so any app can start it with any extra. Opening a
 * screen that way is harmless, but starting the microphone is not: a voice entry only counts when
 * it carries the per-install key that only this App's own intents know.
 */
object QuickEntry {
    const val EXTRA_ENTRY = "com.agentbot.app.ENTRY"
    private const val EXTRA_KEY = "com.agentbot.app.ENTRY_KEY"
    private const val PREF_KEY = "quick_entry_key"

    const val COMPOSE = "compose"
    const val VOICE = "voice"
    const val SESSIONS = "sessions"
    const val QUEUE = "queue"

    fun intent(context: Context, entry: String): Intent =
        Intent(context, MainActivity::class.java)
            // A distinct action per entry keeps their PendingIntents apart and is required by shortcuts
            .setAction("com.agentbot.app.entry.$entry")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_ENTRY, entry)
            .putExtra(EXTRA_KEY, key(context))

    /** True only for an intent this App built itself. */
    fun trusted(context: Context, intent: Intent): Boolean {
        val given = intent.getStringExtra(EXTRA_KEY) ?: return false
        return java.security.MessageDigest.isEqual(given.toByteArray(), key(context).toByteArray())
    }

    /** Strips the entry so a redelivered intent cannot replay it. */
    fun consume(intent: Intent) {
        intent.removeExtra(EXTRA_ENTRY)
        intent.removeExtra(EXTRA_KEY)
    }

    @Synchronized
    private fun key(context: Context): String {
        val prefs = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
        prefs.getString(PREF_KEY, null)?.let { return it }
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val created = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString(PREF_KEY, created).apply()
        return created
    }

    /** Long-press shortcuts on the launcher icon; re-publishing the same set is cheap. */
    fun publishShortcuts(context: Context) {
        val shortcuts = listOf(
            Triple(COMPOSE, "提问", R.drawable.ic_entry_compose),
            Triple(VOICE, "语音提问", R.drawable.ic_entry_voice),
            Triple(SESSIONS, "历史会话", R.drawable.ic_entry_sessions),
            Triple(QUEUE, "任务队列", R.drawable.ic_entry_queue),
        ).mapIndexed { rank, (entry, label, icon) ->
            ShortcutInfoCompat.Builder(context, "entry_$entry")
                .setShortLabel(label)
                .setIcon(IconCompat.createWithResource(context, icon))
                .setIntent(intent(context, entry))
                .setRank(rank)
                .build()
        }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts) }
    }
}
