package com.agentbot.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.core.content.FileProvider
import com.agentbot.app.data.AgentActionResult
import com.agentbot.app.data.AccessResult
import com.agentbot.app.data.AliasEntry
import com.agentbot.app.data.AgentInfo
import com.agentbot.app.data.ApiClient
import com.agentbot.app.data.AttachmentLimits
import com.agentbot.app.data.Diagnostics
import com.agentbot.app.data.LocalStore
import com.agentbot.app.data.LogTail
import com.agentbot.app.data.MediaCache
import com.agentbot.app.data.PendingAttachment
import com.agentbot.app.data.ProxyInfo
import com.agentbot.app.data.ApiException
import com.agentbot.app.data.AgentBinding
import com.agentbot.app.data.CcExecCommand
import com.agentbot.app.data.CcProviderDraft
import com.agentbot.app.data.CcProviderMeta
import com.agentbot.app.data.CcStatus
import com.agentbot.app.data.ConfigView
import com.agentbot.app.data.Connection
import com.agentbot.app.data.CustomModel
import com.agentbot.app.data.DirInfo
import com.agentbot.app.data.HelpView
import com.agentbot.app.data.HistoryEntry
import com.agentbot.app.data.Health
import com.agentbot.app.data.ModelEntry
import com.agentbot.app.data.NotConfiguredException
import com.agentbot.app.data.OpsResult
import com.agentbot.app.data.Reminder
import com.agentbot.app.data.Schedule
import com.agentbot.app.data.SentAttachment
import com.agentbot.app.data.ServerInfo
import com.agentbot.app.data.ServiceStatus
import com.agentbot.app.data.Session
import com.agentbot.app.data.SettingsRepository
import com.agentbot.app.data.Status
import com.agentbot.app.data.Task
import com.agentbot.app.data.TaskMedia
import com.agentbot.app.data.TaskNotifier
import com.agentbot.app.data.Usage
import com.agentbot.app.data.UsageTrendDay
import com.agentbot.app.data.decodeMediaBitmap
import com.agentbot.app.data.mediaMime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One chat bubble. Assistant messages with a taskId poll their task until it settles. */
data class ChatMessage(
    val role: Role,
    val text: String,
    val taskId: String? = null,
    val status: String? = null,
    /** Live progress line reported by the server while the task runs. */
    val progress: String? = null,
    /** Server-side start time, used to tick the elapsed label while running. */
    val startedAt: Long? = null,
    val at: Long = System.currentTimeMillis(),
    /** Reply media the agent produced, mirroring what Telegram receives. */
    val media: List<TaskMedia> = emptyList(),
    /** Attachments sent with this user message (names/sizes only). */
    val attachments: List<SentAttachment> = emptyList(),
) {
    enum class Role { USER, ASSISTANT }
}

sealed interface Screen {
    data object Chat : Screen
    data object History : Screen
    data object Reminders : Screen
    data object Schedules : Screen
    data object Session : Screen
    data object Queue : Screen
    data object Agents : Screen
    data object Ops : Screen
    data object Proxy : Screen
    data object Aliases : Screen
    data object Access : Screen
    data object Models : Screen
    data object Cc : Screen
    data object Config : Screen
    data object Status : Screen
    data object Help : Screen
    data object Settings : Screen
}

class AppViewModel(
    private val settings: SettingsRepository,
    context: Context,
) : ViewModel() {
    private val appContext = context.applicationContext
    private val api = ApiClient()

    var screen by mutableStateOf<Screen>(Screen.Chat)
        private set

    var configured by mutableStateOf(settings.connection() != null)
        private set

    /** Configured server address, shown alongside server-reported pairing info. */
    val serverUrl: String get() = settings.baseUrl

    var serverInfo by mutableStateOf<ServerInfo?>(null)
        private set

    var helpView by mutableStateOf<HelpView?>(null)
        private set

    /** Selected `/help` tab: basic, full or cc. */
    var helpSection by mutableStateOf("basic")
        private set

    var connectionError by mutableStateOf<String?>(null)
        private set

    var session by mutableStateOf<Session?>(null)
        private set

    var health by mutableStateOf<Health?>(null)
        private set

    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set

    /** Task the chat should scroll to and highlight (set from a completion notification). */
    var focusTaskId by mutableStateOf<String?>(null)
        private set

    /** Decoded reply images keyed "taskId/index"; bubbles request them the first time they show. */
    var mediaImages by mutableStateOf<Map<String, Bitmap>>(emptyMap())
        private set

    /** Media keys that failed to download or decode. */
    var mediaErrors by mutableStateOf<Set<String>>(emptySet())
        private set

    private val mediaLoads = mutableSetOf<String>()

    var busy by mutableStateOf(false)
        private set

    var agents by mutableStateOf<List<AgentInfo>>(emptyList())
        private set

    var models by mutableStateOf<List<ModelEntry>>(emptyList())
        private set

    var customModels by mutableStateOf<List<CustomModel>>(emptyList())
        private set

    var agentBindings by mutableStateOf<List<AgentBinding>>(emptyList())
        private set

    var modelBusy by mutableStateOf(false)
        private set

    /** Set when a delete is blocked by in-use bindings; the dialog offers a force delete. */
    var modelDeleteBlocked by mutableStateOf<String?>(null)
        private set

    var modelDeleteBlockedKey by mutableStateOf<String?>(null)
        private set

    var ccStatus by mutableStateOf<CcStatus?>(null)
        private set

    /** Mutating `/cc` commands the server allowlists; rendered as the danger zone. */
    var ccCommands by mutableStateOf<List<CcExecCommand>>(emptyList())
        private set

    /** Values for the provider create form; fetched when the form opens. */
    var ccProviderMeta by mutableStateOf<CcProviderMeta?>(null)
        private set

    /** A cc-switch sub-command is running (speedtest can take a while). */
    var ccBusy by mutableStateOf(false)
        private set

    var ccTestMessage by mutableStateOf<String?>(null)
        private set

    /** Last text sub-panel (proxy / mcp / prompts / env), shown in a card. */
    var ccPanelTitle by mutableStateOf<String?>(null)
        private set

    var ccPanelText by mutableStateOf<String?>(null)
        private set

    var configView by mutableStateOf<ConfigView?>(null)
        private set

    var configBusy by mutableStateOf(false)
        private set

    var history by mutableStateOf<List<HistoryEntry>>(emptyList())
        private set

    /** Window size the app requests, the equivalent of Telegram's `/history <条数>`. */
    var historyLimit by mutableStateOf(30)
        private set

    /** Records the server still holds, which can exceed what the window shows. */
    var historyTotal by mutableStateOf(0)
        private set

    var reminders by mutableStateOf<List<Reminder>>(emptyList())
        private set

    var schedules by mutableStateOf<List<Schedule>>(emptyList())
        private set

    var usage by mutableStateOf<Usage?>(null)
        private set

    var trend by mutableStateOf<List<UsageTrendDay>>(emptyList())
        private set

    var status by mutableStateOf<Status?>(null)
        private set

    var dirInfo by mutableStateOf<DirInfo?>(null)
        private set

    var timezone by mutableStateOf<String?>(null)
        private set

    var queue by mutableStateOf<List<Task>>(emptyList())
        private set

    var diagnostics by mutableStateOf<Diagnostics?>(null)
        private set

    var logTail by mutableStateOf<LogTail?>(null)
        private set

    var logSource by mutableStateOf("bot")
        private set

    var logLines by mutableStateOf(80)
        private set

    var opsBusy by mutableStateOf(false)
        private set

    var serviceStatus by mutableStateOf<ServiceStatus?>(null)
        private set

    var opsResult by mutableStateOf<OpsResult?>(null)
        private set

    /** Label of the running ops action (update/build can take minutes). */
    var opsActionBusy by mutableStateOf<String?>(null)
        private set

    /** Engine id while an install/update/uninstall runs; installs can take minutes. */
    var agentBusy by mutableStateOf<String?>(null)
        private set

    var agentResult by mutableStateOf<AgentActionResult?>(null)
        private set

    var aliases by mutableStateOf<List<AliasEntry>>(emptyList())
        private set

    var accessUsers by mutableStateOf<List<String>>(emptyList())
        private set

    var allowAllUsers by mutableStateOf(false)
        private set

    var proxies by mutableStateOf<List<ProxyInfo>>(emptyList())
        private set

    var activeProxyId by mutableStateOf<Int?>(null)
        private set

    var proxyBusy by mutableStateOf(false)
        private set

    /** Result of the last proxy connectivity test, shown above the list. */
    var proxyTestMessage by mutableStateOf<String?>(null)
        private set

    var toast by mutableStateOf<String?>(null)
        private set

    /** Attachments staged for the next message; cleared on send. */
    var pendingAttachments by mutableStateOf<List<PendingAttachment>>(emptyList())
        private set

    /**
     * Engine for the next message only, matching `POST /task`'s engine override. The session
     * default (and Telegram) stay untouched, so a one-off Codex run cannot strand the chat.
     */
    var oneOffEngine by mutableStateOf<String?>(null)
        private set

    /** Model for the next message only, the companion of the engine pin above. */
    var oneOffModel by mutableStateOf<String?>(null)
        private set

    /** Switchable models for the pinned engine, loaded when the pin changes. */
    var oneOffModels by mutableStateOf<List<ModelEntry>>(emptyList())
        private set

    val oneOffEngineLabel: String?
        get() = oneOffEngine?.let { id -> agents.firstOrNull { it.id == id }?.label ?: id }

    fun setOneOffEngine(engine: String?) {
        oneOffEngine = engine?.takeIf { it.isNotBlank() }
        oneOffModel = null
        oneOffModels = emptyList()
        val pinned = oneOffEngine ?: return
        // A pin may target another engine than the session, so ask for that engine's list
        silent { oneOffModels = api.models(conn(), pinned) }
    }

    fun setOneOffModel(model: String?) {
        oneOffModel = model?.takeIf { it.isNotBlank() }
    }

    val oneOffModelLabel: String?
        get() = oneOffModel?.let { value -> oneOffModels.firstOrNull { it.value == value }?.label ?: value }

    /** Silent engine list for the chat picker; the Agents screen owns the error-banner version. */
    fun refreshAgentsQuietly() {
        silent { agents = api.agents(conn()) }
    }

    /** Unsent input, persisted so switching screens or a process restart keeps the text. */
    var draft by mutableStateOf("")
        private set

    fun setDraft(text: String) {
        draft = text
        LocalStore.saveDraft(appContext, text)
    }

    private val polls = mutableMapOf<String, Job>()

    init {
        messages = LocalStore.loadMessages(appContext)
        draft = LocalStore.loadDraft(appContext)
        TaskNotifier.ensureChannel(appContext)
        // A task may still be running after the process was killed: resume polling it
        if (settings.connection() != null) {
            messages.filter { it.taskId != null && (it.status == "queued" || it.status == "running") }
                .forEach { message -> message.taskId?.let { pollTask(it) } }
        }
    }

    fun stageAttachment(attachment: PendingAttachment): Boolean {
        if (pendingAttachments.size >= AttachmentLimits.MAX_COUNT) {
            toast = "最多附带 ${AttachmentLimits.MAX_COUNT} 个附件"
            return false
        }
        val total = pendingAttachments.sumOf { it.sizeBytes } + attachment.sizeBytes
        if (total > AttachmentLimits.MAX_TOTAL_BYTES) {
            toast = "附件总大小超过 ${AttachmentLimits.MAX_TOTAL_BYTES / 1024 / 1024}MB"
            return false
        }
        pendingAttachments = pendingAttachments + attachment
        return true
    }

    fun removeAttachment(index: Int) {
        pendingAttachments = pendingAttachments.filterIndexed { i, _ -> i != index }
    }

    /** Text shared from another app, handed to the chat input once it is composed. */
    var sharedDraft by mutableStateOf<String?>(null)
        private set

    /** ACTION_SEND from other apps: fill the draft and stage streams, never auto-send. */
    fun acceptShare(context: Context, text: String?, uris: List<Uri>) {
        val clean = text?.trim().orEmpty()
        if (clean.isNotEmpty()) sharedDraft = clean
        navigate(Screen.Chat)
        if (uris.isEmpty()) return
        viewModelScope.launch {
            var staged = 0
            for (uri in uris) {
                try {
                    val attachment = withContext(Dispatchers.IO) { LocalStore.read(context, uri) }
                    if (stageAttachment(attachment)) staged++
                } catch (_: Exception) {
                }
            }
            if (staged < uris.size) toast = "部分分享内容无法读取"
        }
    }

    fun consumeSharedDraft() {
        sharedDraft = null
    }

    /** Jumps to the chat and asks it to reveal this task's message (notification tap). */
    fun focusTask(taskId: String) {
        focusTaskId = taskId
        navigate(Screen.Chat)
    }

    fun consumeFocusTask() {
        focusTaskId = null
    }

    fun navigate(to: Screen) {
        screen = to
        connectionError = null
        when (to) {
            Screen.History -> refreshHistory()
            Screen.Reminders -> refreshReminders()
            Screen.Schedules -> refreshSchedules()
            Screen.Session -> {
                refreshDir()
                refreshTimezone()
            }
            Screen.Queue -> refreshQueue()
            Screen.Agents -> refreshAgents()
            Screen.Ops -> {
                refreshDiagnostics()
                refreshLogs()
                refreshOpsService()
            }
            Screen.Proxy -> refreshProxies()
            Screen.Aliases -> refreshAliases()
            Screen.Access -> refreshAccess()
            Screen.Models -> refreshCustomModels()
            Screen.Cc -> refreshCc()
            Screen.Config -> refreshConfig()
            Screen.Status -> refreshStatus()
            Screen.Help -> refreshHelp()
            else -> Unit
        }
        if (session == null) refreshSession()
    }

    fun saveConnection(baseUrl: String, token: String) {
        settings.baseUrl = baseUrl
        settings.token = token
        configured = settings.connection() != null
        session = null
        health = null
        refreshSession()
        navigate(Screen.Chat)
    }

    private fun conn(): Connection = settings.connection() ?: throw NotConfiguredException()

    /** Runs a suspended block, surfacing failures as an in-app error banner. */
    private fun guarded(label: String, block: suspend () -> Unit): Job = viewModelScope.launch {
        try {
            block()
        } catch (err: Exception) {
            connectionError = if (err is NotConfiguredException) err.message else "$label失败：${err.message}"
        }
    }

    fun refreshSession() {
        guarded("连接") {
            health = api.health(conn())
            session = api.session(conn())
            connectionError = null
        }
    }

    /** Refreshes the visible tab after the app returns to the foreground; failures stay silent. */
    fun onForeground() {
        silent { health = api.health(conn()); session = api.session(conn()) }
        when (screen) {
            Screen.History -> silent { loadHistory() }
            Screen.Reminders -> silent { reminders = api.reminders(conn()) }
            Screen.Schedules -> silent { schedules = api.schedules(conn()) }
            Screen.Queue -> pollQueue()
            Screen.Agents -> silent { agents = api.agents(conn()) }
            Screen.Models -> silent { models = api.models(conn()) }
            Screen.Session -> {
                silent { dirInfo = api.dir(conn()) }
                silent { timezone = api.timezone(conn()) }
            }
            Screen.Status -> silent {
                status = api.status(conn())
                val (summary, days) = api.usage(conn())
                usage = summary
                trend = days
                serverInfo = api.info(conn())
            }
            Screen.Proxy -> silent {
                val list = api.proxies(conn())
                proxies = list.proxies
                activeProxyId = list.active
            }
            Screen.Aliases -> silent { aliases = api.aliases(conn()) }
            Screen.Access -> silent {
                val info = api.access(conn())
                accessUsers = info.users
                allowAllUsers = info.allowAll
            }
            Screen.Cc -> if (!ccBusy) silent {
                val status = api.ccStatus(conn())
                ccStatus = status
                if (status.available) ccCommands = api.ccExecCommands(conn())
            }
            Screen.Config -> silent { configView = api.config(conn()) }
            Screen.Help -> silent { helpView = api.help(conn()) }
            Screen.Ops -> if (opsActionBusy == null) {
                silent { diagnostics = api.diagnostics(conn()) }
                silent { serviceStatus = api.opsService(conn()) }
                silent { logTail = api.logs(conn(), logSource, logLines) }
            }
            else -> Unit
        }
    }

    /** Like [guarded] but for background refreshes where a banner would only be noise. */
    private fun silent(block: suspend () -> Unit) = viewModelScope.launch {
        try {
            block()
        } catch (_: Exception) {
        }
    }

    fun refreshAgents() {
        guarded("加载引擎") { agents = api.agents(conn()) }
    }

    fun refreshCustomModels() {
        guarded("加载自定义模型") {
            val result = api.customModels(conn())
            customModels = result.models
            agentBindings = result.agents
        }
    }

    /** Input format matches `/cc model add 简称 provider/modelID [显示名]`. */
    fun addCustomModel(input: String) {
        val tokens = input.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.size < 2) {
            connectionError = "用法：简称 provider/modelID [显示名]，例如：mymodel custom/my-model-id"
            return
        }
        val key = tokens[0]
        val slash = tokens[1].indexOf('/')
        if (slash <= 0 || slash == tokens[1].length - 1) {
            connectionError = "第二项必须是 provider/modelID，例如 custom/my-model-id"
            return
        }
        val providerID = tokens[1].substring(0, slash)
        val modelID = tokens[1].substring(slash + 1)
        val label = tokens.drop(2).joinToString(" ").ifBlank { null }
        viewModelScope.launch {
            modelBusy = true
            try {
                val result = api.addCustomModel(conn(), key, providerID, modelID, label)
                toast = result.message ?: "已添加模型"
                refreshCustomModels()
                refreshModels()
            } catch (err: Exception) {
                connectionError = "添加模型失败：${err.message}"
            } finally {
                modelBusy = false
            }
        }
    }

    /** Mirrors `/cc model assign`: bind an agent (or `self`) to a model shorthand. */
    fun assignAgentModel(agent: String, model: String) {
        if (modelBusy) return
        viewModelScope.launch {
            modelBusy = true
            try {
                val result = api.assignAgent(conn(), agent, model)
                toast = result.sessionMessage?.let { "${result.message} $it" } ?: result.message
                refreshCustomModels()
                refreshSession()
            } catch (err: Exception) {
                connectionError = "绑定 Agent 模型失败：${err.message}"
            } finally {
                modelBusy = false
            }
        }
    }

    fun removeCustomModel(key: String, force: Boolean = false) {        viewModelScope.launch {
            modelBusy = true
            try {
                toast = api.removeCustomModel(conn(), key, force)
                modelDeleteBlocked = null
                modelDeleteBlockedKey = null
                refreshCustomModels()
                refreshModels()
                refreshSession()
            } catch (err: ApiException) {
                if (err.code == 409 && !force) {
                    modelDeleteBlocked = err.message
                    modelDeleteBlockedKey = key
                } else {
                    connectionError = "删除模型失败：${err.message}"
                }
            } catch (err: Exception) {
                connectionError = "删除模型失败：${err.message}"
            } finally {
                modelBusy = false
            }
        }
    }

    fun clearModelDeleteBlocked() {
        modelDeleteBlocked = null
        modelDeleteBlockedKey = null
    }

    // ---- cc-switch console ----

    fun refreshCc() {
        guarded("加载 cc-switch") {
            val status = api.ccStatus(conn())
            ccStatus = status
            if (status.available) ccCommands = api.ccExecCommands(conn())
        }
    }

    /** Loads cc-switch's templates and API formats before the provider form opens. */
    fun ccProviderFormMeta() {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                ccProviderMeta = api.ccProviderMeta(conn())
            } catch (err: Exception) {
                connectionError = "读取 Provider 模板失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc provider add …`: the typed twin of the Telegram command. */
    fun ccAddProvider(draft: CcProviderDraft) {
        if (ccBusy) return
        val name = draft.name.trim()
        if (name.isEmpty()) {
            toast = "请填写 Provider 名称"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val optional = { value: String? -> value?.trim()?.takeIf { it.isNotEmpty() } }
                val result = api.ccAddProvider(
                    conn(),
                    draft.copy(
                        name = name,
                        id = optional(draft.id),
                        baseUrl = optional(draft.baseUrl),
                        apiKey = optional(draft.apiKey),
                        model = optional(draft.model),
                        config = optional(draft.config),
                    ),
                )
                toast = result.message.ifBlank { if (result.ok) "已创建 Provider「$name」" : "创建 Provider 失败" }
                ccPanelTitle = "🧩 新建 Provider · $name"
                ccPanelText = result.text
                // A new provider changes the list and the danger zone in one go
                val status = api.ccStatus(conn())
                ccStatus = status
                if (status.available) ccCommands = api.ccExecCommands(conn())
            } catch (err: Exception) {
                connectionError = "创建 Provider 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun ccUse(id: String) {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccUse(conn(), id)
                toast = result.message.ifBlank { "已切换 Provider" }
                ccTestMessage = null
                refreshCc()
            } catch (err: Exception) {
                connectionError = "切换 Provider 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** Tests the given provider, or the current one when [id] is null (same as `/cc test`). */
    fun ccTest(id: String? = null) {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            ccTestMessage = "测速中…"
            try {
                val result = api.ccTest(conn(), id)
                ccTestMessage = if (result.ok) {
                    buildString {
                        append(result.id)
                        result.latencyMs?.let { append(" · ").append(it).append("ms") }
                        result.status?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                    }
                } else {
                    "${result.id} 测速失败：${result.text.take(300)}"
                }
            } catch (err: Exception) {
                ccTestMessage = "测速失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** Loads one of the read-only cc-switch panels by name. */
    fun ccShowPanel(kind: String) {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val (title, text) = when (kind) {
                    "proxy" -> "cc-switch 代理" to api.ccProxy(conn())
                    "mcp" -> "MCP 列表" to api.ccMcp(conn())
                    "prompts" -> "提示词" to api.ccPrompts(conn())
                    "env-tools" -> "环境工具" to api.ccEnv(conn(), "tools").text
                    "config" -> "cc-switch 配置" to api.ccView(conn(), "config")
                    "sessions" -> "会话列表" to api.ccView(conn(), "sessions")
                    "auth" -> "认证状态" to api.ccView(conn(), "auth")
                    "skills" -> "技能列表" to api.ccView(conn(), "skills")
                    "failover" -> "故障转移" to api.ccView(conn(), "failover")
                    "daemon" -> "守护进程" to api.ccView(conn(), "daemon")
                    "settings" -> "cc-switch 设置" to api.ccView(conn(), "settings")
                    else -> "环境检查" to api.ccEnv(conn(), "check").text
                }
                ccPanelTitle = title
                ccPanelText = text
            } catch (err: Exception) {
                connectionError = "加载 $kind 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun ccSyncMcp() {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccSyncMcp(conn())
                toast = result.message.ifBlank { "MCP 已同步" }
                ccPanelTitle = "MCP 列表"
                ccPanelText = api.ccMcp(conn())
            } catch (err: Exception) {
                connectionError = "同步 MCP 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun ccActivatePrompt(id: String) {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccActivatePrompt(conn(), id)
                toast = result.message.ifBlank { "提示词已启用" }
                ccPanelTitle = "提示词"
                ccPanelText = api.ccPrompts(conn())
            } catch (err: Exception) {
                connectionError = "启用提示词失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun ccDeactivatePrompt() {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccDeactivatePrompt(conn())
                toast = result.message.ifBlank { "提示词已停用" }
                ccPanelTitle = "提示词"
                ccPanelText = api.ccPrompts(conn())
            } catch (err: Exception) {
                connectionError = "停用提示词失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc stream <id>`: confirms the provider really streams instead of only answering. */
    fun ccStream(id: String) {
        if (ccBusy || id.isBlank()) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccStream(conn(), id)
                ccPanelTitle = "📡 流式检查 · $id"
                ccPanelText = result.text
            } catch (err: Exception) {
                connectionError = "流式检查失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc models <id>`: the model list the provider itself reports. */
    fun ccProviderModels(id: String) {
        if (ccBusy || id.isBlank()) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccProviderModels(conn(), id)
                ccPanelTitle = "🧾 可用模型 · $id"
                ccPanelText = result.text
            } catch (err: Exception) {
                connectionError = "拉取模型列表失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc mcp import <json>`: paste an mcpServers block, then the list refreshes. */
    fun ccImportMcp(raw: String) {
        if (ccBusy) return
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            toast = "请粘贴 MCP 配置 JSON"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccImportMcp(conn(), trimmed)
                toast = result.message.ifBlank { "已提交 MCP 导入" }
                ccPanelTitle = "MCP 列表"
                ccPanelText = api.ccMcp(conn())
            } catch (err: Exception) {
                connectionError = "导入 MCP 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc prompt new <name>`: create a prompt file, then the list refreshes. */
    fun ccCreatePrompt(name: String, content: String) {
        if (ccBusy) return
        val promptName = name.trim()
        if (promptName.isEmpty() || content.isBlank()) {
            toast = "请填写名称与提示词内容"
            return
        }
        if (promptName.any { it.isWhitespace() }) {
            toast = "提示词名称不能包含空格"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccCreatePrompt(conn(), promptName, content)
                toast = result.message.ifBlank { "已创建提示词 $promptName" }
                ccPanelTitle = "提示词"
                ccPanelText = api.ccPrompts(conn())
            } catch (err: Exception) {
                connectionError = "创建提示词失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc sessions search <关键词>`; the read-only listing stays on the 会话 view. */
    fun ccSessionsSearch(query: String) {
        if (ccBusy) return
        val trimmed = query.trim()
        if (trimmed.isEmpty()) {
            toast = "请输入搜索关键词"
            return
        }
        if (trimmed.startsWith("-")) {
            toast = "关键词不能以 - 开头"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccSessionsSearch(conn(), trimmed)
                ccPanelTitle = "🔍 会话搜索 · $trimmed"
                ccPanelText = result.text
            } catch (err: Exception) {
                connectionError = "搜索会话失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc deeplink <ccswitch://…>` after the app-side confirmation. */
    fun ccDeeplink(url: String) {
        if (ccBusy) return
        val trimmed = url.trim()
        if (!trimmed.startsWith("ccswitch://v1/import?")) {
            toast = "只接受 ccswitch://v1/import?... 形式的链接"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccDeeplink(conn(), trimmed)
                toast = result.message.ifBlank { if (result.ok) "已导入 Deep Link" : "Deep Link 导入失败" }
                ccPanelTitle = "🔗 Deep Link 导入"
                ccPanelText = result.text
                // A link can add providers, so the console should show the new state at once
                ccStatus = api.ccStatus(conn())
                ccCommands = api.ccExecCommands(conn())
            } catch (err: Exception) {
                connectionError = "Deep Link 导入失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** `/cc quota <id>`: usage read-out only, never the credit-burning reset. */
    fun ccQuota(id: String) {
        if (ccBusy || id.isBlank()) return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccQuota(conn(), id)
                ccPanelTitle = "📊 配额 · $id"
                ccPanelText = result.text
            } catch (err: Exception) {
                connectionError = "读取配额失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /** Runs one allowlisted mutating command; the server re-checks the confirm flag. */
    fun runCcExec(name: String, arg: String?, confirm: Boolean) {
        if (ccBusy) return
        val command = ccCommands.find { it.name == name } ?: return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccExec(conn(), name, arg, confirm)
                toast = result.message.ifBlank { if (result.ok) "已完成：${command.label}" : "执行失败：${command.label}" }
                ccPanelTitle = "🛠 ${command.label}"
                ccPanelText = result.text
                if (name == "provider-delete") ccStatus = api.ccStatus(conn())
            } catch (err: Exception) {
                connectionError = "${command.label} 失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun clearCcPanel() {
        ccPanelTitle = null
        ccPanelText = null
        ccTestMessage = null
    }

    // ---- env config ----

    fun refreshConfig() {
        guarded("加载配置") { configView = api.config(conn()) }
    }

    fun addConfig(input: String) {
        val trimmed = input.trim()
        val space = trimmed.indexOfFirst { it.isWhitespace() }
        if (space <= 0) {
            connectionError = "用法：KEY 值，例如 LOG_LEVEL debug"
            return
        }
        setConfig(trimmed.substring(0, space), trimmed.substring(space + 1).trim())
    }

    fun setConfig(key: String, value: String) {
        if (configBusy) return
        viewModelScope.launch {
            configBusy = true
            try {
                val result = api.setConfig(conn(), key, value)
                configView = result.config
                toast = result.message.ifBlank { "已更新 $key" }
                if (key.uppercase() == "REMINDER_TIMEZONE") refreshTimezone()
            } catch (err: Exception) {
                connectionError = "更新配置失败：${err.message}"
            } finally {
                configBusy = false
            }
        }
    }

    fun unsetConfig(key: String) {
        if (configBusy) return
        viewModelScope.launch {
            configBusy = true
            try {
                val result = api.unsetConfig(conn(), key)
                configView = result.config
                toast = result.message.ifBlank { "已删除 $key" }
            } catch (err: Exception) {
                connectionError = "删除配置失败：${err.message}"
            } finally {
                configBusy = false
            }
        }
    }

    fun refreshModels() {
        guarded("加载模型") { models = api.models(conn()) }
    }

    fun refreshHistory() {
        guarded("加载历史") { loadHistory() }
    }

    fun setHistoryLimit(limit: Int) {
        if (limit == historyLimit) return
        historyLimit = limit
        guarded("加载历史") { loadHistory() }
    }

    private suspend fun loadHistory() {
        val page = api.history(conn(), historyLimit)
        history = page.first
        historyTotal = page.second
    }

    /** The full history document for the share sheet; throws on transport errors. */
    suspend fun historyExport(): String = api.exportHistory(conn(), "markdown")

    fun clearHistory() {
        guarded("清空历史") {
            api.clearHistory(conn())
            history = emptyList()
            historyTotal = 0
            toast = "历史已清空"
        }
    }

    fun refreshReminders() {
        guarded("加载提醒") { reminders = api.reminders(conn()) }
    }

    fun refreshSchedules() {
        guarded("加载定时任务") { schedules = api.schedules(conn()) }
    }

    fun refreshStatus() {
        guarded("加载状态") {
            status = api.status(conn())
            val (summary, days) = api.usage(conn())
            usage = summary
            trend = days
            serverInfo = api.info(conn())
        }
    }

    fun refreshHelp() {
        guarded("加载帮助") { helpView = api.help(conn()) }
    }

    fun selectHelpSection(id: String) {
        helpSection = id
        if (helpView == null) refreshHelp()
    }

    fun refreshDir() {
        guarded("加载工作目录") { dirInfo = api.dir(conn()) }
    }

    fun setWorkDir(path: String) {
        guarded("切换工作目录") {
            dirInfo = api.setDir(conn(), path)
            session = api.session(conn())
            toast = "工作目录已更新"
        }
    }

    fun resetWorkDir() {
        guarded("恢复默认目录") {
            dirInfo = api.resetDir(conn())
            session = api.session(conn())
            toast = "已恢复默认工作目录"
        }
    }

    fun refreshTimezone() {
        guarded("加载时区") { timezone = api.timezone(conn()) }
    }

    fun changeTimezone(zone: String) {
        guarded("切换时区") {
            val message = api.setTimezone(conn(), zone)
            timezone = api.timezone(conn())
            session = api.session(conn())
            toast = message
        }
    }

    fun refreshQueue() {
        guarded("加载队列") { queue = api.queue(conn()) }
    }

    /** Auto-refresh for the queue screen: a flaky link must not paint an error banner. */
    fun pollQueue() {
        viewModelScope.launch {
            try {
                queue = api.queue(conn())
            } catch (_: Exception) {
            }
        }
    }

    fun stopTask(id: String) {
        guarded("停止任务") {
            api.stopTask(conn(), id)
            refreshQueue()
            toast = "已请求停止"
        }
    }

    /** Re-runs one failed or stopped assistant message; the server replays the original prompt. */
    fun retryTask(taskId: String) {
        val index = messages.indexOfFirst { it.taskId == taskId }
        if (index < 0) return
        viewModelScope.launch {
            try {
                // the stored task carries attachments and the one-off model pin, which a
                // client-side text copy would silently drop
                val task = api.retryTask(conn(), taskId)
                messages = messages.toMutableList().also { list ->
                    list[index] = ChatMessage(ChatMessage.Role.ASSISTANT, "", taskId = task.id, status = task.status)
                }
                persistMessages()
                pollTask(task.id)
            } catch (err: Exception) {
                connectionError = "重试失败：${err.message}"
            }
        }
    }

    fun resetModel() {
        guarded("恢复默认模型") {
            val message = api.setModel(conn(), "default")
            session = api.session(conn())
            toast = message
        }
    }

    fun refreshAccess() {
        guarded("加载白名单") {
            val info = api.access(conn())
            accessUsers = info.users
            allowAllUsers = info.allowAll
        }
    }

    fun addAccess(id: String) {
        val trimmed = id.trim()
        if (trimmed.isEmpty()) return
        guarded("添加白名单") {
            val result: AccessResult = api.addAccess(conn(), trimmed)
            accessUsers = result.users
            allowAllUsers = result.allowAll
            toast = result.message ?: "已加入白名单"
        }
    }

    fun removeAccess(id: String) {
        guarded("移除白名单") {
            val result: AccessResult = api.removeAccess(conn(), id)
            accessUsers = result.users
            allowAllUsers = result.allowAll
            toast = result.message ?: "已移出白名单"
        }
    }

    fun refreshAliases() {
        guarded("加载快捷指令") { aliases = api.aliases(conn()) }
    }

    /** Silent refresh for the chat palette; a failed lookup must not paint an error banner. */
    fun refreshAliasesQuietly() {
        silent { aliases = api.aliases(conn()) }
    }

    /** Input format matches `/alias add 名称 指令内容`: first word is the name. */
    fun addAlias(input: String) {
        val trimmed = input.trim()
        val name = trimmed.substringBefore(' ').removePrefix("/")
        val expansion = trimmed.substringAfter(' ', "").trim()
        if (name.isEmpty() || expansion.isEmpty()) {
            connectionError = "用法：名称 指令内容，例如：code 审查当前目录的代码"
            return
        }
        guarded("创建快捷指令") {
            toast = api.addAlias(conn(), name, expansion)
            refreshAliases()
        }
    }

    fun deleteAlias(name: String) {
        guarded("删除快捷指令") {
            api.deleteAlias(conn(), name)
            refreshAliases()
            toast = "已删除 /$name"
        }
    }

    fun refreshProxies() {
        guarded("加载代理") {
            val list = api.proxies(conn())
            proxies = list.proxies
            activeProxyId = list.active
        }
    }

    fun addProxy(input: String) {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return
        val url = trimmed.substringBefore(' ')
        val name = trimmed.substringAfter(' ', "").trim().ifEmpty { null }
        guarded("添加代理") {
            proxyBusy = true
            try {
                val result = api.addProxy(conn(), url, name)
                toast = result.message ?: "代理已添加"
                refreshProxies()
            } finally {
                proxyBusy = false
            }
        }
    }

    fun useProxy(id: Int) {
        guarded("启用代理") {
            proxyBusy = true
            try {
                val result = api.useProxy(conn(), id)
                toast = result.message ?: "代理已启用"
                proxyTestMessage = null
                refreshProxies()
            } finally {
                proxyBusy = false
            }
        }
    }

    fun testProxy(id: Int) {
        viewModelScope.launch {
            proxyBusy = true
            try {
                val result = api.testProxy(conn(), id)
                val latency = result.latencyMs?.let { " · ${it}ms" } ?: ""
                proxyTestMessage = (if (result.ok) "✅ 连接正常" else "❌ 连接失败") + latency +
                    (result.message?.takeIf { !result.ok }?.let { "：$it" } ?: "")
            } catch (err: Exception) {
                proxyTestMessage = "❌ 测试失败：${err.message}"
            } finally {
                proxyBusy = false
            }
        }
    }

    fun removeProxy(id: Int) {
        guarded("删除代理") {
            proxyBusy = true
            try {
                toast = api.removeProxy(conn(), id)
                refreshProxies()
            } finally {
                proxyBusy = false
            }
        }
    }

    fun disableProxy() {
        guarded("停用代理") {
            proxyBusy = true
            try {
                toast = api.disableProxy(conn())
                proxyTestMessage = null
                refreshProxies()
            } finally {
                proxyBusy = false
            }
        }
    }

    fun refreshDiagnostics() {
        viewModelScope.launch {
            opsBusy = true
            try {
                diagnostics = api.diagnostics(conn())
            } catch (err: Exception) {
                connectionError = "加载诊断失败：${err.message}"
            } finally {
                opsBusy = false
            }
        }
    }

    fun refreshOpsService() {
        guarded("加载服务状态") { serviceStatus = api.opsService(conn()) }
    }

    /** Runs an /ops action; update/check/restart can take minutes and block the button. */
    fun runOpsAction(path: String, label: String) {
        if (opsActionBusy != null) return
        viewModelScope.launch {
            opsActionBusy = label
            try {
                val result = api.runOps(conn(), path)
                opsResult = result
                toast = result.message ?: "$label完成"
                if (path.startsWith("service")) refreshOpsService()
            } catch (err: Exception) {
                // A restart may kill the process that is answering this request
                if (path == "restart") toast = "已发送重启指令（连接可能短暂中断，稍后刷新）"
                else connectionError = "$label失败：${err.message}"
            } finally {
                opsActionBusy = null
            }
        }
    }

    fun clearOpsResult() {
        opsResult = null
    }

    fun refreshLogs(source: String = logSource, lines: Int = logLines) {
        logSource = source
        logLines = lines
        viewModelScope.launch {
            opsBusy = true
            try {
                logTail = api.logs(conn(), source, lines)
            } catch (err: Exception) {
                connectionError = "加载日志失败：${err.message}"
            } finally {
                opsBusy = false
            }
        }
    }

    /** Installs, updates or uninstalls an Agent CLI; the caller confirms first. */
    fun runAgentAction(engine: String, action: String) {
        if (agentBusy != null) return
        viewModelScope.launch {
            agentBusy = engine
            try {
                val result = api.agentAction(conn(), engine, action)
                agentResult = result
                toast = result.message ?: "操作完成"
                agents = api.agents(conn())
                session = api.session(conn())
            } catch (err: Exception) {
                connectionError = "操作失败：${err.message}"
            } finally {
                agentBusy = null
            }
        }
    }

    fun clearAgentResult() {
        agentResult = null
    }

    fun switchAgent(engine: String) {
        guarded("切换引擎") {
            session = api.switchAgent(conn(), engine)
            toast = "已切换到 ${session?.engineLabel ?: engine}"
            refreshModels()
        }
    }

    fun setModel(model: ModelEntry) {
        guarded("切换模型") {
            val message = api.setModel(conn(), model.value)
            session = api.session(conn())
            toast = message
        }
    }

    fun newChat() {
        messages = emptyList()
        mediaImages = emptyMap()
        mediaErrors = emptySet()
        LocalStore.clearMessages(appContext)
        guarded("新会话") {
            api.newSession(conn())
            session = api.session(conn())
            toast = "已开启新会话"
        }
    }

    /** Queues a prompt; returns false when it was rejected (busy or empty). */
    fun send(text: String): Boolean {
        val raw = text.trim()
        if (busy) return false
        val attachments = pendingAttachments
        val engine = oneOffEngine
        val model = oneOffModel
        if (raw.isEmpty() && attachments.isEmpty()) return false
        viewModelScope.launch {
            try {
                busy = true
                // `/name` shortcuts expand server-side with the bot's 3-hop rule, so submit as typed.
                val task = api.submitTask(conn(), raw, attachments, engine, model)
                oneOffEngine = null
                oneOffModel = null
                oneOffModels = emptyList()
                pendingAttachments = emptyList()
                val sentAt = System.currentTimeMillis()
                val sent = attachments.map { SentAttachment(it.name, it.mime, it.sizeBytes) }
                messages = messages + ChatMessage(ChatMessage.Role.USER, raw, at = sentAt, attachments = sent) +
                    ChatMessage(ChatMessage.Role.ASSISTANT, "", taskId = task.id, status = task.status, at = sentAt)
                persistMessages()
                pollTask(task.id)
            } catch (err: Exception) {
                connectionError = "发送失败：${err.message}"
                // Give the text back so a dropped connection never eats the prompt.
                if (draft.isBlank()) setDraft(raw)
                // ...and keep the one-off pins so a plain retry repeats the same request.
                oneOffEngine = engine
                oneOffModel = model
            } finally {
                busy = false
            }
        }
        return true
    }

    /** Re-sends the last failed user prompt (the error banner's 重试, also `/retry`). */
    fun retryLastFailed() {
        val lastUser = messages.lastOrNull { it.role == ChatMessage.Role.USER }
        if (lastUser == null || lastUser.text.isBlank()) {
            toast = "没有可重试的任务"
            return
        }
        if (!send(lastUser.text)) toast = "任务执行中，请先等待或停止当前任务"
    }

    fun stop() {
        guarded("停止") {
            api.stopTasks(conn())
            if (screen == Screen.Queue) refreshQueue()
            toast = "已请求停止"
        }
    }

    private fun pollTask(id: String) {
        if (polls.containsKey(id)) return
        polls[id] = viewModelScope.launch {
            try {
                try {
                    // Preferred path: the SSE stream pushes every progress line and
                    // the terminal snapshot with no polling delay
                    api.streamTask(conn(), id) { task -> applyTaskSnapshot(id, task) }
                    return@launch
                } catch (err: Exception) {
                    // Missing endpoint, broken stream or auth hiccup: polling is the
                    // authoritative fallback and produces the real error messages
                }
                pollTaskLoop(id)
            } catch (err: Exception) {
                val reason = if (err is ApiException) "任务查询失败：${err.message}" else "任务查询中断：${err.message}"
                updateMessage(id) { it.copy(status = "failed", text = it.text.ifEmpty { reason }) }
            } finally {
                polls.remove(id)
                if (screen == Screen.Queue) refreshQueue()
            }
        }
    }

    private fun applyTaskSnapshot(id: String, task: com.agentbot.app.data.Task) {
        updateMessage(id) {
            it.copy(
                status = task.status,
                text = task.reply ?: task.error ?: it.text,
                progress = task.progress,
                startedAt = task.startedAt ?: it.startedAt,
                media = task.media.ifEmpty { it.media },
            )
        }
        if (!task.isRunning && !AppVisibility.foreground) TaskNotifier.taskSettled(appContext, task)
    }

    private suspend fun pollTaskLoop(id: String) {
        var networkFailures = 0
        while (true) {
            val task = try {
                api.task(conn(), id)
            } catch (err: ApiException) {
                throw err
            } catch (err: IOException) {
                // Wi-Fi handovers and server restarts are transient: the task keeps
                // running server-side, so retry with backoff instead of failing it.
                networkFailures++
                updateMessage(id) { it.copy(progress = "连接中断，正在重试…") }
                delay(minOf(3_000L * networkFailures, 15_000L))
                continue
            }
            networkFailures = 0
            applyTaskSnapshot(id, task)
            if (!task.isRunning) break
            delay(1_500)
        }
    }

    private fun updateMessage(taskId: String, transform: (ChatMessage) -> ChatMessage) {
        messages = messages.map { if (it.taskId == taskId) transform(it) else it }
        persistMessages()
    }

    private fun persistMessages() {
        LocalStore.saveMessages(appContext, messages)
    }

    /** Downloads and decodes one reply image; the bubble calls this from LaunchedEffect. */
    fun loadMediaImage(taskId: String, media: TaskMedia, retry: Boolean = false) {
        val key = "$taskId/${media.index}"
        if (retry) mediaErrors = mediaErrors - key
        if (mediaImages.containsKey(key) || mediaErrors.contains(key) || !mediaLoads.add(key)) return
        viewModelScope.launch {
            try {
                val bytes = mediaBytes(taskId, media)
                val bitmap = withContext(Dispatchers.IO) { decodeMediaBitmap(bytes) }
                if (bitmap != null) {
                    mediaImages = mediaImages + (key to bitmap)
                } else {
                    mediaErrors = mediaErrors + key
                }
            } catch (_: Exception) {
                mediaErrors = mediaErrors + key
            } finally {
                mediaLoads.remove(key)
            }
        }
    }

    /** Hands one reply media item to an external viewer; falls back to the share sheet. */
    fun openMedia(taskId: String, media: TaskMedia) {
        viewModelScope.launch {
            try {
                mediaBytes(taskId, media)
                val file = MediaCache.file(appContext, taskId, media.index, media.name)
                val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", file)
                val mime = mediaMime(media.name)
                val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK
                try {
                    appContext.startActivity(
                        Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(flags),
                    )
                } catch (_: ActivityNotFoundException) {
                    val share = Intent(Intent.ACTION_SEND).setType(mime)
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(flags)
                    appContext.startActivity(Intent.createChooser(share, media.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            } catch (err: Exception) {
                connectionError = "无法打开 ${media.name}：${err.message}"
            }
        }
    }

    private suspend fun mediaBytes(taskId: String, media: TaskMedia): ByteArray {
        MediaCache.read(appContext, taskId, media.index, media.name)?.let { return it }
        return api.taskMedia(conn(), taskId, media.index)
            .also { MediaCache.write(appContext, taskId, media.index, media.name, it) }
    }

    fun addReminder(text: String) {
        guarded("添加提醒") {
            api.addReminder(conn(), text)
            refreshReminders()
            toast = "提醒已创建"
        }
    }

    fun deleteReminder(id: Long) {
        guarded("删除提醒") {
            api.deleteReminder(conn(), id)
            refreshReminders()
        }
    }

    fun addSchedule(text: String) {
        guarded("添加定时任务") {
            api.addSchedule(conn(), text)
            refreshSchedules()
            toast = "定时任务已创建"
        }
    }

    fun setSchedulePaused(id: Long, pause: Boolean) {
        guarded("暂停/恢复") {
            api.pauseSchedule(conn(), id, pause)
            refreshSchedules()
        }
    }

    fun deleteSchedule(id: Long) {
        guarded("删除定时任务") {
            api.deleteSchedule(conn(), id)
            refreshSchedules()
        }
    }

    fun runScheduleNow(id: Long) {
        guarded("立即执行定时任务") {
            api.runSchedule(conn(), id)
            refreshSchedules()
            toast = "已开始执行定时任务 #$id，结果会发送到 Telegram"
        }
    }

    fun clearQueue() {
        guarded("清空队列") {
            val cleared = api.clearQueue(conn())
            refreshQueue()
            toast = if (cleared.isEmpty()) "队列已经是空的" else "已取消 ${cleared.size} 条排队任务"
        }
    }

    fun consumeToast() {
        toast = null
    }

    /** One-off message raised by screens that own a local interaction (e.g. voice recording). */
    fun showToast(message: String) {
        toast = message
    }

    companion object {
        fun formatTime(ms: Long): String =
            SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(ms))

        /** Matches Telegram's formatDuration: rounds to seconds, then 分/小时/天. */
        fun formatDuration(ms: Long): String {
            val seconds = ((ms.coerceAtLeast(0) + 500) / 1000).toInt()
            if (seconds < 60) return "$seconds 秒"
            val minutes = seconds / 60
            if (minutes < 60) return "$minutes 分 ${seconds % 60} 秒"
            val hours = minutes / 60
            if (hours < 24) return "$hours 小时 ${minutes % 60} 分"
            return "${hours / 24} 天 ${hours % 24} 小时"
        }
    }
}
