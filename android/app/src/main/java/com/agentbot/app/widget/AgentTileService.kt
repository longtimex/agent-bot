package com.agentbot.app.widget

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile: one tap from anywhere opens the chat with the keyboard up. It lights up
 * while a task runs, and on Android 10+ its subtitle says what the newest task is doing.
 */
class AgentTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val state = WidgetStateStore.load(this)
        tile.label = "Agent 提问"
        tile.state = if (state?.running == true) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = state?.headline ?: "点按提问"
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        // The chat is private: on a locked phone the user unlocks first
        if (isLocked) unlockAndRun { open() } else open()
    }

    private fun open() {
        val intent = QuickEntry.intent(this, QuickEntry.COMPOSE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 refuses the Intent overload for apps targeting it
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 10, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    companion object {
        /** Asks the system to rebind the tile so it reads the new state; a no-op when it is not added. */
        fun refresh(context: Context) {
            runCatching { requestListeningState(context, ComponentName(context, AgentTileService::class.java)) }
        }
    }
}
