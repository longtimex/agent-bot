package com.agentbot.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import android.widget.Toast
import com.agentbot.app.R
import com.agentbot.app.data.ApiClient
import com.agentbot.app.data.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Date

/** Home-screen widget: the newest task at a glance, plus 提问 / 语音 / 停止. */
class AgentWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val views = render(context)
        for (id in ids) manager.updateAppWidget(id, views)
    }

    companion object {
        /** A running task older than this was probably settled while the App was not around to see it. */
        private const val STALE_MS = 15 * 60_000L

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(context, AgentWidgetProvider::class.java))
            if (ids.isEmpty()) return
            val views = render(context)
            for (id in ids) manager.updateAppWidget(id, views)
        }

        private fun render(context: Context): RemoteViews {
            val state = WidgetStateStore.load(context) ?: WidgetState("Agent Bot", "点「提问」开始")
            val views = RemoteViews(context.packageName, R.layout.widget_agent)
            views.setTextViewText(R.id.widget_headline, state.headline)
            views.setTextViewText(R.id.widget_detail, state.detail)
            val time = if (state.updatedAt > 0) DateFormat.getTimeFormat(context).format(Date(state.updatedAt)) else ""
            val stale = state.running && state.updatedAt > 0 && System.currentTimeMillis() - state.updatedAt > STALE_MS
            views.setTextViewText(
                R.id.widget_time,
                when {
                    stale -> "$time · 可能已结束，打开 App 刷新"
                    time.isNotEmpty() -> "更新于 $time"
                    else -> ""
                },
            )
            views.setViewVisibility(R.id.widget_stop, if (state.running) View.VISIBLE else View.GONE)

            views.setOnClickPendingIntent(R.id.widget_root, activity(context, QuickEntry.COMPOSE, 1))
            views.setOnClickPendingIntent(R.id.widget_ask, activity(context, QuickEntry.COMPOSE, 2))
            views.setOnClickPendingIntent(R.id.widget_voice, activity(context, QuickEntry.VOICE, 3))
            val stop = Intent(context, WidgetActionReceiver::class.java).setAction(WidgetActionReceiver.ACTION_STOP)
            views.setOnClickPendingIntent(
                R.id.widget_stop,
                PendingIntent.getBroadcast(context, 4, stop, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
            return views
        }

        private fun activity(context: Context, entry: String, code: Int): PendingIntent =
            PendingIntent.getActivity(
                context,
                code,
                QuickEntry.intent(context, entry),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
    }
}

/**
 * The widget's 停止 button. A separate, non-exported receiver: the widget provider has to be
 * exported for the launcher, and another app must not be able to stop the user's tasks through it.
 */
class WidgetActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STOP) return
        val app = context.applicationContext
        val connection = SettingsRepository(app).connection()
        if (connection == null) {
            toast(app, "还没有连接服务器，请先打开 App 配对")
            return
        }
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // A broadcast has about ten seconds before the system calls it an ANR
                val stopped = try {
                    withTimeoutOrNull(8_000L) { ApiClient().stopTasks(connection) }
                } catch (err: Exception) {
                    toast(app, "停止失败：${err.message}")
                    return@launch
                }
                when {
                    stopped == null -> toast(app, "服务器没有及时响应，请打开 App 查看")
                    stopped.isEmpty() -> {
                        toast(app, "当前没有正在执行的任务")
                        settleWidget(app, "没有正在执行的任务")
                    }
                    else -> {
                        toast(app, "已请求停止 ${stopped.size} 条任务")
                        settleWidget(app, "已请求停止 ${stopped.size} 条任务")
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    /** The App may not be running to see the task settle, so the widget stops claiming it runs. */
    private fun settleWidget(context: Context, detail: String) {
        val current = WidgetStateStore.load(context) ?: return
        if (!current.running) return
        WidgetStateStore.save(context, current.copy(headline = "已停止", detail = detail, running = false, updatedAt = System.currentTimeMillis()))
        AgentWidgetProvider.refresh(context)
        AgentTileService.refresh(context)
    }

    private fun toast(context: Context, text: String) {
        Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_SHORT).show() }
    }

    companion object {
        const val ACTION_STOP = "com.agentbot.app.widget.STOP"
    }
}
