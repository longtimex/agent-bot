package com.agentbot.app.ui

/**
 * Whether the single activity is visible. Task notifications are only posted
 * while the user is elsewhere; foreground results already show in the chat.
 */
object AppVisibility {
    @Volatile
    var foreground = true
}
