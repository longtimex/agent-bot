package com.agentbot.app.data

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Builds the system share sheet without this App as a destination.
 *
 * MainActivity also accepts ACTION_SEND so text from other apps can become a draft. Left in
 * the chooser, that filter makes Agent Bot look like a share target for its own report,
 * backup or history export: choosing it replaces the draft with the export and navigates
 * away from the screen that started the share.
 */
object ShareIntents {
    fun chooser(context: Context, send: Intent, title: String): Intent {
        val own = context.packageManager
            .queryIntentActivities(send, PackageManager.MATCH_DEFAULT_ONLY)
            .mapNotNull { info ->
                val activity = info.activityInfo ?: return@mapNotNull null
                if (activity.packageName == context.packageName) {
                    ComponentName(activity.packageName, activity.name)
                } else {
                    null
                }
            }
        // The resolver reads EXTRA_EXCLUDE_COMPONENTS from the chooser, not from the
        // ACTION_SEND intent embedded in it.
        return Intent.createChooser(send, title).apply {
            if (own.isNotEmpty()) putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, own.toTypedArray())
        }
    }
}
