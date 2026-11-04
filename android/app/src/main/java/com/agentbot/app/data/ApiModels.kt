package com.agentbot.app.data

import kotlinx.serialization.Serializable

@Serializable
data class Task(
    val id: String,
    val status: String,
    val text: String,
    val engine: String? = null,
    val model: String? = null,
    val progress: String? = null,
    val reply: String? = null,
    val error: String? = null,
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val attachmentCount: Int? = null,
    /** Files the agent produced, mirroring what Telegram receives. */
    val media: List<TaskMedia> = emptyList(),
) {
    val isRunning: Boolean get() = status == "queued" || status == "running"
}

/** One media item attached to a task reply; bytes are fetched from /task/:id/media/:index. */
@Serializable
data class TaskMedia(
    val index: Int,
    val kind: String,
    val label: String = "",
    val name: String = "",
    val size: Long = 0,
    val remote: Boolean = false,
) {
    val sizeLabel: String
        get() = when {
            size >= 1024 * 1024 -> "%.1fMB".format(size / 1024.0 / 1024.0)
            size >= 1024 -> "${(size + 1023) / 1024}KB"
            else -> "${size}B"
        }
}

@Serializable
data class ModelRef(
    val providerID: String,
    val modelID: String,
    val label: String,
) {
    /** How Telegram names the same model: `provider/modelID`. */
    val address: String get() = "$providerID/$modelID"
}

@Serializable
data class Session(
    val key: String? = null,
    val engine: String? = null,
    val engineLabel: String? = null,
    val engineInstalled: Boolean? = null,
    val model: String? = null,
    /** Only OpenCode sessions resolve to a provider pair; CLI engines report a bare id. */
    val modelRef: ModelRef? = null,
    val hasSession: Boolean? = null,
    val workDir: String? = null,
    val timezone: String? = null,
) {
    /** The model line Telegram's /session shows: the label, with its address underneath. */
    val modelLine: String
        get() = model?.let { name -> modelRef?.let { "$name（${it.address}）" } ?: name } ?: "-"
}

/**
 * What a session has really run. The server reads this from the usage store both ends write
 * to, so the other end's numbers are not guessed. Prompt text never travels — only counts
 * and the last activity timestamp.
 */
@Serializable
data class PeerActivity(
    val lastAt: Long = 0,
    val lastEngine: String? = null,
    val lastModel: String? = null,
    val todayTasks: Int = 0,
    val todayOk: Int = 0,
    val totalTasks: Int = 0,
)

/**
 * Another live session the Bot knows about — normally the Telegram chat the App shadows.
 * The server never sends the session key, because for Telegram that key is the chat id.
 */
@Serializable
data class Peer(
    val scope: String,
    val label: String,
    val current: Boolean = false,
    val session: Session? = null,
    val activity: PeerActivity? = null,
)

@Serializable
data class AgentInfo(
    val id: String,
    val label: String,
    val desc: String? = null,
    /** Extra words that select this engine, exactly as Telegram's `/engine` accepts them. */
    val aliases: List<String> = emptyList(),
    /** The command the CLI runs as; the built-in OpenCode engine has none. */
    val bin: String? = null,
    val installed: Boolean = false,
    val install: String? = null,
    /** "session" / "preassign" / "capture" / "stateless": whether context carries over. */
    val sessionMode: String? = null,
    val supportsModel: Boolean? = null,
    val defaultModel: String? = null,
    /** The models this CLI offers, sent only for engines that can switch them. */
    val models: List<AgentModelOption> = emptyList(),
    val experimental: Boolean? = null,
    val managed: Boolean = false,
    val installable: Boolean = false,
    val updateable: Boolean = false,
    val uninstallable: Boolean = false,
    val installCommand: String? = null,
    val updateCommand: String? = null,
    val uninstallCommand: String? = null,
) {
    /** Telegram treats every mode except "stateless" as keeping context between messages. */
    val stateless: Boolean get() = sessionMode == "stateless"
}

@Serializable
data class AgentModelOption(
    val id: String,
    val label: String,
    val desc: String? = null,
    val aliases: List<String> = emptyList(),
)

@Serializable
data class AgentActionResult(
    val ok: Boolean = false,
    val message: String? = null,
    val output: String? = null,
)

@Serializable
data class Diagnostics(
    val node: String? = null,
    val platform: String? = null,
    val pid: Int? = null,
    val systemd: Boolean? = null,
    val projectDir: String? = null,
    val uptimeSec: Long = 0,
    val git: GitInfo? = null,
    val opencode: OpencodeInfo? = null,
    val ccSwitch: CcSwitchInfo? = null,
    val log: FileInfo? = null,
    val opencodeLog: FileInfo? = null,
    val disk: DiskInfo? = null,
    val memory: MemoryInfo? = null,
    val lastBackupAt: Long = 0,
)

@Serializable
data class GitInfo(val branch: String? = null, val commit: String? = null, val dirty: Boolean? = null)

@Serializable
data class OpencodeInfo(
    val url: String? = null,
    val reachable: Boolean? = null,
    val managed: Boolean? = null,
    val pid: Int? = null,
)

@Serializable
data class CcSwitchInfo(val bin: String? = null, val version: String? = null)

@Serializable
data class FileInfo(val path: String? = null, val bytes: Long = 0)

@Serializable
data class DiskInfo(val freeBytes: Long = 0, val totalBytes: Long = 0)

@Serializable
data class MemoryInfo(val freeBytes: Long = 0, val totalBytes: Long = 0)

@Serializable
data class AccessInfo(
    val users: List<String> = emptyList(),
    val allowAll: Boolean = false,
)

@Serializable
data class AccessResult(
    val ok: Boolean = false,
    val message: String? = null,
    val users: List<String> = emptyList(),
    val allowAll: Boolean = false,
)

@Serializable
data class AliasEntry(
    val name: String,
    val expansion: String,
    val createdAt: Long = 0,
)

@Serializable
data class ProxyInfo(
    val id: Int,
    val name: String,
    /** Already masked by the server; credentials never reach the app. */
    val url: String,
    val protocol: String? = null,
    val active: Boolean = false,
    val createdAt: Long = 0,
)

@Serializable
data class ProxyList(
    val active: Int? = null,
    val proxies: List<ProxyInfo> = emptyList(),
)

@Serializable
data class ProxyActionResult(
    val ok: Boolean = false,
    val message: String? = null,
    val proxy: ProxyInfo? = null,
)

@Serializable
data class ProxyTestResult(
    val ok: Boolean = false,
    val message: String? = null,
    val latencyMs: Long? = null,
)

@Serializable
data class OpsStep(
    val label: String = "",
    val ok: Boolean = false,
    val code: Int? = null,
    val output: String = "",
)

@Serializable
data class OpsResult(
    val ok: Boolean = false,
    val message: String? = null,
    val steps: List<OpsStep> = emptyList(),
)

@Serializable
data class ServiceStatus(
    val reachable: Boolean = false,
    val managed: Boolean = false,
    val pid: Int? = null,
    val url: String? = null,
)

@Serializable
data class LogTail(
    val ok: Boolean = false,
    val missing: Boolean = false,
    val path: String? = null,
    val bytes: Long = 0,
    val text: String = "",
)

@Serializable
data class CustomModel(
    val key: String,
    val providerID: String,
    val modelID: String,
    val label: String,
    val desc: String? = null,
)

@Serializable
data class AgentBinding(
    val name: String,
    val model: String? = null,
    val description: String? = null,
    val mode: String? = null,
)

@Serializable
data class CustomModels(
    val models: List<CustomModel> = emptyList(),
    val agents: List<AgentBinding> = emptyList(),
)

@Serializable
data class CustomModelResult(
    val ok: Boolean = false,
    val message: String? = null,
    val model: CustomModel? = null,
)

@Serializable
data class ModelEntry(
    /** OpenCode models carry a registry key; CLI models carry the raw model id. */
    val key: String? = null,
    val id: String? = null,
    val label: String,
    val desc: String? = null,
    /** Only OpenCode models are addressed as provider/model. */
    val providerID: String? = null,
    val modelID: String? = null,
    /** Short names that resolve to this model, as `/model sonnet` does in Telegram. */
    val aliases: List<String> = emptyList(),
) {
    val value: String get() = key ?: id ?: label
    /** Shown under the label: the raw id OpenCode/CLI receives, or the aliases to type. */
    val detail: String
        get() = providerID?.let { "$it/${modelID ?: ""}" }
            ?: aliases.takeIf { it.isNotEmpty() }?.joinToString("、")
            ?: value
}

@Serializable
data class ModelChoices(
    val engine: String? = null,
    val models: List<ModelEntry> = emptyList(),
    /** Engines whose model list the CLI owns get a one-line hint instead of a list. */
    val modelHint: String? = null,
)

@Serializable
data class DirInfo(
    val engine: String? = null,
    val workDir: String? = null,
    val defaultWorkDir: String? = null,
    /** Set only when this session has a directory other than the bot default. */
    val custom: String? = null,
    val note: String? = null,
)

@Serializable
data class Health(
    val ok: Boolean = false,
    val name: String? = null,
    val version: String? = null,
    val engine: String? = null,
    val timezone: String? = null,
    val uptimeMs: Long = 0,
    val encryption: Boolean = false,
)

@Serializable
data class HistoryEntry(
    val at: Long,
    val prompt: String,
    val engine: String? = null,
    val model: String? = null,
    val ms: Long = 0,
    val outcome: String = "failed",
    val scheduled: Boolean? = null,
)

/** One day's totals as `src/usage.ts` sends them: counts plus the summed duration. */
@Serializable
data class UsageDay(
    val tasks: Int = 0,
    val ok: Int = 0,
    val failed: Int = 0,
    val cancelled: Int = 0,
    val totalMs: Long = 0,
) {
    val avgMs: Long
        get() = if (tasks > 0) totalMs / tasks else 0
}

@Serializable
data class Usage(
    val tasks: Int = 0,
    val ok: Int = 0,
    val failed: Int = 0,
    val cancelled: Int = 0,
    val totalMs: Long = 0,
    val lastAt: Long = 0,
    val lastEngine: String? = null,
    val lastModel: String? = null,
    val today: UsageDay = UsageDay(),
    val engines: Map<String, Int> = emptyMap(),
) {
    val avgMs: Long
        get() = if (tasks > 0) totalMs / tasks else 0
}

@Serializable
data class UsageTrendDay(
    val day: String,
    val tasks: Int = 0,
    val ok: Int = 0,
    val failed: Int = 0,
    val cancelled: Int = 0,
    val totalMs: Long = 0,
)

/** One chat's slice of the cross-chat daily report (`source` is the display label). */
@Serializable
data class DailyReportSource(
    val source: String,
    val usage: UsageDay = UsageDay(),
    val key: String = "",
)

/** `GET /usage/report`: today summed over every chat, plus the 7-day trend. */
@Serializable
data class DailyReport(
    val day: String,
    val text: String = "",
    val totals: UsageDay = UsageDay(),
    val byChat: List<DailyReportSource> = emptyList(),
    val trend: List<UsageTrendDay> = emptyList(),
) {
    val trendTasks: Int
        get() = trend.sumOf { it.tasks }
}

@Serializable
data class Reminder(
    val id: Long,
    val text: String,
    val dueAt: Long,
    val repeat: Repeat? = null,
)

@Serializable
data class Repeat(val type: String? = null, val ms: Long? = null, val hour: Int? = null, val minute: Int? = null) {
    fun describe(): String? = when (type) {
        "interval" -> "每 ${formatDuration(ms ?: 0)}"
        "daily" -> "每天 %02d:%02d".format(hour ?: 0, minute ?: 0)
        else -> null
    }

    private fun formatDuration(ms: Long): String {
        val minutes = ms / 60_000
        return when {
            minutes >= 1440 -> "${minutes / 1440} 天"
            minutes >= 60 -> "${minutes / 60} 小时"
            minutes >= 1 -> "$minutes 分钟"
            else -> "${ms / 1000} 秒"
        }
    }
}

@Serializable
data class Schedule(
    val id: Long,
    val prompt: String,
    val dueAt: Long,
    val engine: String? = null,
    /** "引擎 / 模型" line from the server, honouring `--engine/--model` flags. */
    val target: String? = null,
    val repeat: Repeat? = null,
    val paused: Boolean = false,
    val lastRunAt: Long? = null,
    val lastStatus: String? = null,
)

@Serializable
data class Status(
    val uptimeMs: Long = 0,
    val version: String? = null,
    val timezone: String? = null,
    val engine: String? = null,
    val usageToday: UsageDay? = null,
    val opencodeReachable: Boolean? = null,
    /** Queued or running right now, as Telegram's /status names it. */
    val activeTask: Task? = null,
    /** Live task rows the server still tracks, including finished ones kept for retry. */
    val tasksTotal: Int = 0,
    val tasksActive: Int = 0,
)

@Serializable
data class CcProvider(val id: String, val name: String = "", val current: Boolean = false)

@Serializable
data class CcStatus(
    val available: Boolean = false,
    val app: String = "opencode",
    val bin: String? = null,
    val version: String? = null,
    val providers: List<CcProvider> = emptyList(),
    val current: String? = null,
    val error: String? = null,
)

@Serializable
data class CcTestResult(
    val ok: Boolean = false,
    val id: String,
    val latencyMs: Long? = null,
    val status: String? = null,
    val text: String = "",
)

@Serializable
data class CcText(val mode: String? = null, val text: String = "")

@Serializable
data class CcActionResult(val ok: Boolean = false, val message: String = "", val text: String = "")

/** cc-switch's allowed values for the provider form, plus its field limits. */
@Serializable
data class CcProviderMeta(
    val app: String = "",
    /** False when cc-switch only accepts raw settings JSON for this app. */
    val fieldMode: Boolean = true,
    val templates: List<String> = emptyList(),
    val apiFormats: List<String> = emptyList(),
    val nameMaxLength: Int = 80,
    val configMaxLength: Int = 20_000,
)

/** A new provider as typed on the app; blank fields stay out of the request. */
data class CcProviderDraft(
    val name: String,
    val id: String? = null,
    val template: String? = null,
    val baseUrl: String? = null,
    val apiKey: String? = null,
    val model: String? = null,
    val apiFormat: String? = null,
    val config: String? = null,
)

/** One allowlisted mutating `/cc` command; the server sends the list so the app never hardcodes it. */
@Serializable
data class CcExecCommand(
    val name: String,
    val label: String,
    val group: String = "其他",
    val needsTarget: Boolean = false,
    val targetLabel: String = "目标 ID",
    val confirm: Boolean = false,
    /** Word runs the chat may type for this command, aliases included (`provider rm`). */
    val tokens: List<String> = emptyList(),
)

/** One read-only `/cc` view; also server-listed, so targets and labels stay in sync. */
@Serializable
data class CcViewSpec(
    val name: String,
    val label: String,
    val needsTarget: Boolean = false,
    val targetLabel: String = "目标 ID",
    /** Word runs the chat may type for this view, so no command word is hardcoded here. */
    val tokens: List<String> = emptyList(),
)

@Serializable
data class CcExecResult(
    val ok: Boolean = false,
    val name: String = "",
    val code: Int = 0,
    val message: String = "",
    val text: String = "",
)

@Serializable
data class ConfigEntry(
    val key: String,
    val value: String? = null,
    val secret: Boolean = false,
    val editable: Boolean = false,
)

@Serializable
data class ConfigView(
    val exists: Boolean = true,
    val entries: List<ConfigEntry> = emptyList(),
    val editableKeys: List<String> = emptyList(),
)

@Serializable
data class ConfigResult(
    val ok: Boolean = false,
    val message: String = "",
    val config: ConfigView = ConfigView(),
)

@Serializable
data class AgentAssignInfo(
    val agent: String,
    val model: String,
    val label: String = "",
)

@Serializable
data class AgentAssignment(
    val ok: Boolean = false,
    val message: String = "",
    val result: AgentAssignInfo? = null,
    val sessionMessage: String? = null,
)

@Serializable
data class ApiEndpointInfo(
    val enabled: Boolean = false,
    val bind: String = "",
    val port: Int = 0,
    val tokenConfigured: Boolean = false,
)

@Serializable
data class ServerInfo(
    val version: String? = null,
    val timezone: String? = null,
    val engine: String? = null,
    val engineLabel: String? = null,
    val model: String? = null,
    val sessionId: String? = null,
    val cliSessionId: String? = null,
    val workDir: String? = null,
    val chatId: Long? = null,
    val api: ApiEndpointInfo = ApiEndpointInfo(),
)

@Serializable
data class HelpSection(
    val id: String,
    val title: String,
    val text: String,
)

/** One command word the bot answers; the server sends the list the App must follow. */
@Serializable
data class BotCommand(
    val command: String,
    val description: String = "",
)

@Serializable
data class HelpView(
    val sections: List<HelpSection> = emptyList(),
    /** The bot's full "/" surface, so the palette and command routing never drift from it. */
    val commands: List<BotCommand> = emptyList(),
    /** Extra words that run a listed command, e.g. tz for timezone. */
    val aliases: Map<String, String> = emptyMap(),
)
