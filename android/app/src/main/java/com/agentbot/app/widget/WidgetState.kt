package com.agentbot.app.widget

import android.content.Context
import com.agentbot.app.ui.ChatMessage
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What the widget and the Quick Settings tile show: one line about the newest task and a short
 * excerpt. The App writes it from the chat writer (already off Main); both surfaces read it back,
 * so they still show the last known state while the App process is gone.
 */
@Serializable
data class WidgetState(
    val headline: String,
    val detail: String,
    val running: Boolean = false,
    val pending: Int = 0,
    /** Device clock: it only labels when this snapshot was taken on this phone. */
    val updatedAt: Long = 0L,
)

object WidgetStateStore {
    private const val PREF_KEY = "widget_state"
    private const val EXCERPT = 80
    private val json = Json { ignoreUnknownKeys = true }

    fun summarize(messages: List<ChatMessage>, pending: Int, configured: Boolean): WidgetState {
        val now = System.currentTimeMillis()
        if (!configured) return WidgetState("未连接服务器", "点按打开 App 完成配对", updatedAt = now)
        val liveIndex = messages.indexOfLast {
            it.role == ChatMessage.Role.ASSISTANT && (it.status == "queued" || it.status == "running")
        }
        if (liveIndex >= 0) {
            val live = messages[liveIndex]
            val prompt = messages.subList(0, liveIndex).lastOrNull { it.role == ChatMessage.Role.USER }?.text.orEmpty()
            val headline = if (live.status == "queued") "排队中" else "执行中"
            return WidgetState(headline, excerpt(prompt).ifEmpty { "Agent 正在处理" }, running = true, pending = pending, updatedAt = now)
        }
        if (pending > 0) {
            return WidgetState("$pending 条消息待发送", "连上服务器后自动发出", pending = pending, updatedAt = now)
        }
        val last = messages.lastOrNull { it.role == ChatMessage.Role.ASSISTANT && it.taskId != null }
            ?: return WidgetState("还没有对话", "点「提问」开始", updatedAt = now)
        return when (last.status) {
            "failed" -> WidgetState("上次任务失败", excerpt(last.text).ifEmpty { last.errorCode ?: "打开 App 查看原因" }, updatedAt = now)
            "done" -> WidgetState("上次回复", excerpt(last.text).ifEmpty { "（附件或空回复）" }, updatedAt = now)
            else -> WidgetState("上次任务已停止", excerpt(last.text), updatedAt = now)
        }
    }

    fun load(context: Context): WidgetState? {
        val raw = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE).getString(PREF_KEY, null) ?: return null
        return runCatching { json.decodeFromString(WidgetState.serializer(), raw) }.getOrNull()
    }

    /** Saves and redraws only when something visible changed; every SSE frame passes through here. */
    fun publish(context: Context, state: WidgetState) {
        val previous = load(context)
        if (previous != null && previous.copy(updatedAt = 0L) == state.copy(updatedAt = 0L)) return
        save(context, state)
        AgentWidgetProvider.refresh(context)
        AgentTileService.refresh(context)
    }

    fun save(context: Context, state: WidgetState) {
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_KEY, json.encodeToString(WidgetState.serializer(), state))
            .apply()
    }

    /** One plain line: Markdown marks and line breaks read as noise on a home screen. */
    private fun excerpt(text: String): String {
        val plain = text.replace(Regex("[`*#>|]+"), "").replace(Regex("\\s+"), " ").trim()
        return if (plain.length > EXCERPT) plain.take(EXCERPT) + "…" else plain
    }
}
