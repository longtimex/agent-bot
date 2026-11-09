package com.agentbot.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.agentbot.app.data.AgentActionResult
import com.agentbot.app.data.AccessResult
import com.agentbot.app.data.AliasEntry
import com.agentbot.app.data.AgentInfo
import com.agentbot.app.data.AndroidReleaseInfo
import com.agentbot.app.data.ApiClient
import com.agentbot.app.data.ApiException
import com.agentbot.app.data.AttachmentLimits
import com.agentbot.app.data.Diagnostics
import com.agentbot.app.data.LocalStore
import com.agentbot.app.data.LogTail
import com.agentbot.app.data.MagpieOverview
import com.agentbot.app.data.MediaCache
import com.agentbot.app.data.PendingAttachment
import com.agentbot.app.data.Peer
import com.agentbot.app.data.ProxyInfo
import com.agentbot.app.data.BotCommand
import com.agentbot.app.data.AgentBinding
import com.agentbot.app.data.CcExecCommand
import com.agentbot.app.data.CcProviderDraft
import com.agentbot.app.data.CcProviderMeta
import com.agentbot.app.data.CcStatus
import com.agentbot.app.data.CcViewSpec
import com.agentbot.app.data.ConfigView
import com.agentbot.app.data.Connection
import com.agentbot.app.data.CustomModel
import com.agentbot.app.data.DirInfo
import com.agentbot.app.data.DirListing
import com.agentbot.app.data.HelpView
import com.agentbot.app.data.HermesMemory
import com.agentbot.app.data.HistoryEntry
import com.agentbot.app.data.Health
import com.agentbot.app.data.ModelChoices
import com.agentbot.app.data.ModelEntry
import com.agentbot.app.data.NotConfiguredException
import com.agentbot.app.data.OpsResult
import com.agentbot.app.data.Reminder
import com.agentbot.app.data.Schedule
import com.agentbot.app.data.SentAttachment
import com.agentbot.app.data.ServerInfo
import com.agentbot.app.data.ReleaseInfo
import com.agentbot.app.data.ServiceStatus
import com.agentbot.app.data.Session
import com.agentbot.app.data.StartupCheck
import com.agentbot.app.data.SettingsRepository
import com.agentbot.app.data.Status
import com.agentbot.app.data.Task
import com.agentbot.app.data.DailyReport
import com.agentbot.app.data.TaskMedia
import com.agentbot.app.data.TaskNotifier
import com.agentbot.app.data.Usage
import com.agentbot.app.data.UsageTrendDay
import com.agentbot.app.data.decodeMediaFile
import com.agentbot.app.data.mediaMime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest
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
    data object Magpie : Screen
    data object Hermes : Screen
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

    /**
     * The server's clock, for labels built from server timestamps (`startedAt`, `lastAt`, a history
     * row's time). The device's own clock is a different clock and the two are never synced here.
     */
    fun serverNow(): Long = api.serverNow()

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

    /** Command words the bot answers, as listed by the server next to the help copy. */
    var botCommands by mutableStateOf<List<BotCommand>>(emptyList())
        private set

    /** Extra words that run a listed command, e.g. `tz` for `timezone`. */
    var botAliases by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    /**
     * The banner both ends share: the ViewModel fills it from failed calls, and screens write
     * local failures into it (microphone, camera, export), so the setter stays open.
     */
    var connectionError by mutableStateOf<String?>(null)

    var session by mutableStateOf<Session?>(null)
        private set

    /** The Bot's other live sessions — normally the Telegram chat this App shadows. */
    var peers by mutableStateOf<List<Peer>>(emptyList())
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

    /**
     * The server refuses session rewiring (`/new`, `/model`, `/dir`, peers follow) while a
     * prompt is queued or running, exactly as Telegram's buttons do; switching the engine is
     * still allowed because it only points the next task elsewhere.
     */
    val hasLiveTask: Boolean
        get() = messages.any {
            it.role == ChatMessage.Role.ASSISTANT && (it.status == "queued" || it.status == "running")
        }

    var agents by mutableStateOf<List<AgentInfo>>(emptyList())
        private set

    var modelChoices by mutableStateOf(ModelChoices())
        private set

    /** The session engine's switchable models; `hint` explains an engine that lists none. */
    val models: List<ModelEntry> get() = modelChoices.models
    val modelHint: String? get() = modelChoices.modelHint

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

    /** Read-only `/cc` views the server offers; some want an id or keyword. */
    var ccViews by mutableStateOf<List<CcViewSpec>>(emptyList())
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

    // ---- magpie ----
    var magpie by mutableStateOf<MagpieOverview?>(null)
    var magpieBusy by mutableStateOf(false)
    var magpieTitle by mutableStateOf("")
    var magpieOutput by mutableStateOf("")
    /** Words awaiting the user's confirmation (the server refused with 「需要确认」). */
    var magpieConfirmation by mutableStateOf<String?>(null)
        private set

    /** Hermes' MEMORY.md / USER.md and the limits line, loaded when the screen opens. */
    var hermes by mutableStateOf<HermesMemory?>(null)
        private set

    var hermesBusy by mutableStateOf(false)
        private set

    /** Last write result, so a truncated-by-budget warning survives the refresh. */
    var hermesMessage by mutableStateOf<String?>(null)
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

    /** Cross-chat aggregate from `/usage/report`; covers Telegram and the App together. */
    var dailyReport by mutableStateOf<DailyReport?>(null)
        private set

    var status by mutableStateOf<Status?>(null)
        private set

    var dirInfo by mutableStateOf<DirInfo?>(null)
        private set

    /** Where the working-directory picker is standing; null while it is closed. */
    var dirBrowse by mutableStateOf<DirListing?>(null)
        private set

    var dirBrowseBusy by mutableStateOf(false)
        private set

    /** Its own error line: a banner would hide behind the dialog. */
    var dirBrowseError by mutableStateOf<String?>(null)
        private set

    var timezone by mutableStateOf<String?>(null)
        private set

    var queue by mutableStateOf<List<Task>>(emptyList())
        private set

    /** Settled records behind the queue screen; the server prunes old ones, so best effort. */
    var recentTasks by mutableStateOf<List<Task>>(emptyList())
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

    /** Managed release state and update channel, loaded alongside diagnostics. */
    var releaseInfo by mutableStateOf<ReleaseInfo?>(null)
        private set

    /** Startup self-check from data/startup-check.json, when the server exposes it. */
    var startupCheck by mutableStateOf<StartupCheck?>(null)
        private set

    /** Installed App version, read from the package manager rather than BuildConfig. */
    private val packageInfo: android.content.pm.PackageInfo? = runCatching {
        appContext.packageManager.getPackageInfo(appContext.packageName, 0)
    }.getOrNull()

    val appVersionName: String = packageInfo?.versionName ?: ""

    val appVersionCode: Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo?.longVersionCode ?: 0L
        } else {
            @Suppress("DEPRECATION")
            packageInfo?.versionCode?.toLong() ?: 0L
        }

    /** Latest APK advertised by the bot; null until /android/release answers. */
    var androidRelease by mutableStateOf<AndroidReleaseInfo?>(null)
        private set

    /** "downloading" / "verifying" / "installing" while the App update is in flight. */
    var appUpdateStage by mutableStateOf<String?>(null)
        private set

    var appUpdateError by mutableStateOf<String?>(null)
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
    var oneOffChoices by mutableStateOf(ModelChoices())
        private set

    val oneOffModels: List<ModelEntry> get() = oneOffChoices.models
    val oneOffModelHint: String? get() = oneOffChoices.modelHint

    val oneOffEngineLabel: String?
        get() = oneOffEngine?.let { id -> agents.firstOrNull { it.id == id }?.label ?: id }

    fun updateOneOffEngine(engine: String?) {
        oneOffEngine = engine?.takeIf { it.isNotBlank() }
        oneOffModel = null
        oneOffChoices = ModelChoices()
        val pinned = oneOffEngine ?: return
        // A pin may target another engine than the session, so ask for that engine's list
        silent { oneOffChoices = api.models(conn(), pinned) }
    }

    fun updateOneOffModel(model: String?) {
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

    fun updateDraft(text: String) {
        draft = text
        // Every keystroke lands here, and one preferences commit serializes the whole file —
        // including the stored chat. Conflated, typing keeps only the last text worth writing.
        draftWrites.trySend(text)
    }

    private val polls = mutableMapOf<String, Job>()

    /**
     * Task ids with a retry request in flight. POST /task/{id}/retry is not idempotent — the server
     * starts a whole new Agent run for every accepted call — so a second tap issued while the first
     * request was still on the wire used to bill two complete runs for one press.
     */
    private val retrying = mutableSetOf<String>()

    /**
     * The chat and the unsent draft are handed to one background writer instead of being stored on
     * the caller's thread. Conflated: a burst of SSE progress frames (or keystrokes) keeps only the
     * newest value, and the writer never exits while values may still arrive, so nothing queued
     * during a write can be dropped.
     */
    private val historyWrites = Channel<List<ChatMessage>>(Channel.CONFLATED)
    private val draftWrites = Channel<String>(Channel.CONFLATED)

    init {
        messages = LocalStore.loadMessages(appContext)
        draft = LocalStore.loadDraft(appContext)
        // The two stored values share one writer each and stay alive for the ViewModel: a writer
        // that ends between sends is how a queued snapshot goes missing.
        viewModelScope.launch(Dispatchers.IO) {
            for (snapshot in historyWrites) {
                LocalStore.writeHistory(appContext, snapshot)
                delay(HISTORY_WRITE_DELAY_MS)
            }
        }
        viewModelScope.launch(Dispatchers.IO) {
            for (text in draftWrites) {
                LocalStore.saveDraft(appContext, text)
                delay(DRAFT_WRITE_DELAY_MS)
            }
        }
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

    /** Reads a picked file away from the main thread; 15 MB of Base64 would freeze the picker. */
    fun stageAttachmentFrom(context: Context, uri: Uri) {
        viewModelScope.launch {
            try {
                stageAttachment(withContext(Dispatchers.IO) { LocalStore.read(context, uri) })
            } catch (err: Exception) {
                connectionError = "读取附件失败：${err.message}"
            }
        }
    }

    /**
     * Reads a finished voice note the same way and sends it, as Telegram does when the button is
     * released. The recording is deleted here rather than by the caller: reading it is a suspend
     * call now, so a cleanup that ran beside it could remove the file before it was opened.
     */
    fun stageVoiceNote(context: Context, file: File, onStaged: () -> Unit) {
        viewModelScope.launch {
            try {
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                val attachment = withContext(Dispatchers.IO) { LocalStore.read(context, uri) }
                // Some resolvers cannot name .m4a; keep the server's audio path intact.
                val audio = if (attachment.mime.startsWith("audio/")) attachment else attachment.copy(mime = "audio/mp4")
                if (stageAttachment(audio)) onStaged()
            } catch (err: Exception) {
                connectionError = "语音发送失败：${err.message}"
            } finally {
                runCatching { file.delete() }
            }
        }
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
            if (staged < uris.size) {
                toast = if (staged == 0) "分享内容无法读取" else "部分分享内容无法读取（已导入 $staged/${uris.size}）"
            }
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
                refreshPeers()
            }
            Screen.Queue -> refreshQueue()
            Screen.Agents -> refreshAgents()
            Screen.Ops -> {
                refreshDiagnostics()
                refreshLogs()
                refreshOpsService()
            }
            Screen.Settings -> refreshAndroidRelease()
            Screen.Proxy -> refreshProxies()
            Screen.Aliases -> refreshAliases()
            Screen.Access -> refreshAccess()
            Screen.Models -> refreshCustomModels()
            Screen.Cc -> refreshCc()
            Screen.Magpie -> refreshMagpie()
            Screen.Hermes -> refreshHermes()
            Screen.Config -> refreshConfig()
            Screen.Status -> refreshStatus()
            Screen.Help -> refreshHelp()
            else -> Unit
        }
        // 未配置连接时导航不再发出注定失败的请求；设置页会在验证成功后建立会话。
        if (session == null && configured) refreshSession()
    }

    /**
     * Probes the typed pairing before replacing what is saved. A wrong tunnel address must fail
     * in front of the fields that need fixing and must not clobber a working old connection; only
     * after health and session both answer does the repository change and the chat open.
     */
    suspend fun saveConnection(baseUrl: String, token: String, encKey: String? = null): Result<Unit> {
        val candidate = Connection(baseUrl.trim(), token.trim(), encKey?.trim()?.ifBlank { null })
        return try {
            val probedHealth = api.health(candidate)
            val probedSession = api.session(candidate)
            settings.baseUrl = candidate.baseUrl
            settings.token = candidate.token
            settings.encKey = candidate.encKey.orEmpty()
            configured = true
            health = probedHealth
            session = probedSession
            connectionError = null
            screen = Screen.Chat
            Result.success(Unit)
        } catch (err: CancellationException) {
            throw err
        } catch (err: Exception) {
            // The saved repository and the live health/session state belong to the old pairing;
            // a typo in a new address must not make a working connection look offline.
            connectionError = if (err is NotConfiguredException) err.message else "连接失败：${err.message}"
            Result.failure(err)
        }
    }

    private fun conn(): Connection = settings.connection() ?: throw NotConfiguredException()

    /**
     * Runs a suspended block, surfacing failures as an in-app error banner.
     *
     * Cancellation is not a failure: leaving the Activity clears the ViewModel scope while a
     * request is mid-flight, and catching that as an error would report a healthy call as broken.
     */
    private fun guarded(label: String, block: suspend () -> Unit): Job = viewModelScope.launch {
        try {
            block()
        } catch (err: CancellationException) {
            throw err
        } catch (err: Exception) {
            // A rejected token already arrives here as UNAUTHORIZED_HINT: ApiException is built
            // from serverFailure(), so no branch has to special-case the server's raw 401 text.
            connectionError = if (err is NotConfiguredException) err.message else "${label}失败：${err.message}"
        }
    }

    fun refreshSession() {
        guarded("连接") {
            health = api.health(conn())
            session = api.session(conn())
            connectionError = null
        }
    }

    fun refreshPeers() {
        guarded("加载对端会话") { peers = api.peers(conn()) }
    }

    /**
     * Takes the other end's engine, model and work dir for this App. Nothing is pushed to
     * Telegram — the two sessions stay separate, and this only aligns the App with it.
     */
    fun followPeer(scope: String) {
        guarded("跟随对端会话") {
            toast = api.followPeer(conn(), scope)
            session = api.session(conn())
            peers = api.peers(conn())
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
            Screen.Models -> silent { modelChoices = api.models(conn()) }
            Screen.Session -> {
                silent { dirInfo = api.dir(conn()) }
                silent { timezone = api.timezone(conn()) }
                silent { peers = api.peers(conn()) }
            }
            Screen.Status -> silent {
                status = api.status(conn())
                val (summary, days) = api.usage(conn())
                usage = summary
                trend = days
                dailyReport = api.usageReport(conn())
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
            Screen.Cc -> if (!ccBusy) silent { reloadCcTables() }
            Screen.Magpie -> if (!magpieBusy) silent { reloadMagpie() }
            Screen.Config -> silent { configView = api.config(conn()) }
            Screen.Help -> silent { helpView = api.help(conn()) }
            Screen.Ops -> if (opsActionBusy == null) {
                silent { diagnostics = api.diagnostics(conn()) }
                silent {
                    val release = api.releaseInfo(conn())
                    releaseInfo = release.release
                    startupCheck = release.startup
                }
                silent { serviceStatus = api.opsService(conn()) }
                silent { logTail = api.logs(conn(), logSource, logLines) }
            }
            Screen.Settings -> silent { androidRelease = api.androidRelease(conn(), appVersionCode.toInt()) }
            else -> Unit
        }
    }

    /** Like [guarded] but for background refreshes where a banner would only be noise. */
    private fun silent(block: suspend () -> Unit) = viewModelScope.launch {
        try {
            block()
        } catch (err: CancellationException) {
            throw err
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
            connectionError = "用法：简称 provider/modelID [显示名] [--attachment] [--context N] [--output N]"
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
        // Telegram's `/cc model add` flags, spelled the same way here so one line works in either client
        var attachment: Boolean? = null
        var contextWindow: Int? = null
        var outputLimit: Int? = null
        val labelParts = mutableListOf<String>()
        var index = 2
        while (index < tokens.size) {
            val token = tokens[index]
            val equals = token.indexOf('=')
            val name = if (equals > 0) token.substring(0, equals) else token
            val inline = if (equals > 0) token.substring(equals + 1) else null
            when (name) {
                "--attachment", "--vision", "-a" -> {
                    attachment = true
                    index += 1
                }

                "--context", "--ctx" -> {
                    val raw = inline ?: tokens.getOrNull(index + 1)
                    contextWindow = positiveLimit(name, raw) ?: return
                    index += if (inline == null) 2 else 1
                }

                "--output", "--max-output" -> {
                    val raw = inline ?: tokens.getOrNull(index + 1)
                    outputLimit = positiveLimit(name, raw) ?: return
                    index += if (inline == null) 2 else 1
                }

                else -> {
                    if (token.startsWith("-")) {
                        connectionError = "未知参数：$token"
                        return
                    }
                    labelParts.add(token)
                    index += 1
                }
            }
        }
        val label = labelParts.joinToString(" ").ifBlank { null }
        viewModelScope.launch {
            modelBusy = true
            try {
                val result = api.addCustomModel(conn(), key, providerID, modelID, label, attachment, contextWindow, outputLimit)
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

    /** `--context 200000` and `--output 64000` take a positive integer, or the dialog says so. */
    private fun positiveLimit(flag: String, raw: String?): Int? {
        val value = raw?.toIntOrNull()
        if (value == null || value <= 0) {
            connectionError = "$flag 需要一个正整数，例如 `$flag 200000`。"
            return null
        }
        return value
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

    /** Reloads the console's server-driven tables, so views and actions never drift apart. */
    private suspend fun reloadCcTables() {
        val status = api.ccStatus(conn())
        ccStatus = status
        if (status.available) {
            ccCommands = api.ccExecCommands(conn())
            ccViews = api.ccViews(conn())
        }
    }

    fun refreshCc() {
        guarded("加载 cc-switch") {
            reloadCcTables()
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
                toast = result.message.ifBlank { if (result.ok) "已创建 Provider「$name」" else "创建 Provider 失败" }
                ccPanelTitle = "新建 Provider · $name"
                ccPanelText = result.text
                // A new provider changes the list and the danger zone in one go
                reloadCcTables()
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

    /** Loads one of the console's dedicated text panels (proxy, MCP, prompts, env). */
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

    /** Opens one of the server-listed read-only views; [target] is needed by some of them. */
    fun ccShowView(view: CcViewSpec, target: String? = null) {
        if (ccBusy) return
        viewModelScope.launch {
            ccBusy = true
            try {
                ccPanelTitle = "🔍 ${view.label}"
                ccPanelText = api.ccView(conn(), view.name, target)
            } catch (err: Exception) {
                connectionError = "加载 ${view.label} 失败：${err.message}"
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
                ccPanelTitle = "流式检查 · $id"
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
                ccPanelTitle = "可用模型 · $id"
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
                toast = result.message.ifBlank { if (result.ok) "已导入 Deep Link" else "Deep Link 导入失败" }
                ccPanelTitle = "Deep Link 导入"
                ccPanelText = result.text
                // A link can add providers, so the console should show the new state at once
                reloadCcTables()
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
                ccPanelTitle = "配额 · $id"
                ccPanelText = result.text
            } catch (err: Exception) {
                connectionError = "读取配额失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    /**
     * Words the bot wants confirmed before a raw cc-switch run: which commands need a tap is
     * the server guard's decision, so the App only asks when Telegram would ask too.
     */
    var ccRawConfirmation by mutableStateOf<String?>(null)
        private set

    /**
     * Telegram's `/cc run <argv>` for any command its guard accepts: the App types the same
     * words. A refusal that asks for confirmation opens the dialog instead of failing, and
     * confirming re-sends the identical argv with `confirm`.
     */
    fun runCcRaw(words: String, confirm: Boolean) {
        if (ccBusy) return
        val argv = ccRawArgv(words)
        if (argv.isEmpty()) {
            toast = "没有要执行的 cc-switch 参数"
            return
        }
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccRun(conn(), argv, confirm)
                val shown = result.command.ifBlank { argv.joinToString(" ") }
                toast = result.message.ifBlank { if (result.ok) "已完成：$shown" else "执行失败：$shown" }
                ccPanelTitle = "⌨️ $shown"
                ccPanelText = result.text
                ccRawConfirmation = null
                // Provider commands change what the console lists, so its header refreshes
                if (argv.first() == "provider") ccStatus = api.ccStatus(conn())
            } catch (err: ApiException) {
                if (!confirm && err.code == 400 && err.message.orEmpty().contains("需要确认")) {
                    ccRawConfirmation = words
                } else {
                    connectionError = "cc-switch 执行失败：${err.message}"
                }
            } catch (err: Exception) {
                connectionError = "cc-switch 执行失败：${err.message}"
            } finally {
                ccBusy = false
            }
        }
    }

    fun confirmCcRaw() {
        val words = ccRawConfirmation ?: return
        ccRawConfirmation = null
        runCcRaw(words, true)
    }

    fun dismissCcRaw() {
        ccRawConfirmation = null
    }

    /** Runs one allowlisted mutating command; the server re-checks the confirm flag. */
    fun runCcExec(name: String, arg: String?, confirm: Boolean) {
        if (ccBusy) return
        val command = ccCommands.find { it.name == name } ?: return
        viewModelScope.launch {
            ccBusy = true
            try {
                val result = api.ccExec(conn(), name, arg, confirm)
                toast = result.message.ifBlank { if (result.ok) "已完成：${command.label}" else "执行失败：${command.label}" }
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

    // ---- magpie ----

    fun refreshMagpie() {
        guarded("加载 magpie") { reloadMagpie() }
    }

    private suspend fun reloadMagpie() {
        magpie = api.magpieOverview(conn())
    }

    /** Runs one read-only view; the server owns the argv, so only a listed name is accepted. */
    fun showMagpieView(name: String, target: String? = null) {
        if (magpieBusy) return
        viewModelScope.launch {
            magpieBusy = true
            try {
                val result = api.magpieView(conn(), name, target)
                magpieTitle = result.label.ifBlank { name }
                magpieOutput = result.text.ifBlank { "（无输出）" }
                connectionError = null
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                magpieTitle = "magpie 错误"
                magpieOutput = err.message ?: "读取失败"
            } finally {
                magpieBusy = false
            }
        }
    }

    /**
     * Telegram's `/magpie run <argv>`. A refusal that asks for confirmation opens the dialog
     * instead of failing; confirming re-sends the identical words with `confirm`.
     */
    fun runMagpie(words: String, confirm: Boolean = false) {
        if (magpieBusy) return
        val argv = words.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        if (argv.isEmpty()) {
            toast = "没有要执行的 magpie 参数"
            return
        }
        viewModelScope.launch {
            magpieBusy = true
            try {
                val result = api.magpieRun(conn(), argv, confirm)
                magpieTitle = argv.take(3).joinToString(" ")
                magpieOutput = result.text.ifBlank { "（无输出）" }
                magpieConfirmation = null
                // The command already succeeded; a refresh hiccup must not turn it into a failure.
                if (argv.first() == "provider" || argv.first() == "group" || argv.first() == "sync") {
                    try {
                        reloadMagpie()
                    } catch (err: CancellationException) {
                        throw err
                    } catch (_: Exception) {
                    }
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: ApiException) {
                if (!confirm && err.code == 400 && err.message.orEmpty().contains("需要确认")) {
                    magpieConfirmation = words
                } else {
                    connectionError = "magpie 执行失败：${err.message}"
                }
            } catch (err: Exception) {
                connectionError = "magpie 执行失败：${err.message}"
            } finally {
                magpieBusy = false
            }
        }
    }

    fun confirmMagpieRun() {
        val words = magpieConfirmation ?: return
        magpieConfirmation = null
        runMagpie(words, true)
    }

    fun dismissMagpieRun() {
        magpieConfirmation = null
    }

    fun clearMagpieOutput() {
        magpieTitle = ""
        magpieOutput = ""
    }

    // ---- Hermes memory ----

    fun refreshHermes() {
        if (hermesBusy) return
        hermesBusy = true
        viewModelScope.launch {
            try {
                hermes = api.hermes(conn())
                connectionError = null
            } catch (err: Exception) {
                connectionError = if (err is NotConfiguredException) err.message else "读取 Hermes 记忆失败：${err.message}"
            } finally {
                hermesBusy = false
            }
        }
    }

    /** `set` and `clear` replace the whole file, so the screen confirms before either posts. */
    fun saveHermes(kind: String, content: String) = hermesWrite(kind, "set", content)

    fun clearHermes(kind: String) = hermesWrite(kind, "clear", null)

    fun setHermesEnabled(kind: String, enabled: Boolean) =
        hermesWrite(kind, if (enabled) "enable" else "disable", null)

    private fun hermesWrite(kind: String, action: String, content: String?) {
        if (hermesBusy) return
        hermesBusy = true
        hermesMessage = null
        viewModelScope.launch {
            try {
                val result = api.hermesAction(conn(), kind, action, content, confirm = action == "set" || action == "clear")
                // The server reports what the file holds now, so the editor shows stored text.
                // When that refresh itself failed the state fields are absent: keeping the last
                // read beats painting an empty editor over text the user might then save back.
                if (result.refreshed) {
                    hermes = HermesMemory(
                        limits = result.limits,
                        memory = result.memory,
                        user = result.user,
                        memoryEnabled = result.memoryEnabled,
                        userEnabled = result.userEnabled,
                    )
                }
                hermesMessage = result.message
            } catch (err: Exception) {
                connectionError = if (err is NotConfiguredException) err.message else "Hermes 记忆操作失败：${err.message}"
            } finally {
                hermesBusy = false
            }
        }
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
        guarded("加载模型") { modelChoices = api.models(conn()) }
    }

    fun refreshHistory() {
        guarded("加载历史") { loadHistory() }
    }

    fun updateHistoryLimit(limit: Int) {
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
    suspend fun historyExport(format: String = "markdown"): String = api.exportHistory(conn(), format)

    /**
     * Set by a typed `/export json` so the history page runs the share sheet it already
     * owns; the ViewModel has no Android intent business.
     */
    var exportRequested by mutableStateOf<String?>(null)
        private set

    fun requestExport(format: String) {
        exportRequested = format
        navigate(Screen.History)
    }

    fun clearExportRequest() {
        exportRequested = null
    }

    /**
     * A destructive maintenance action typed as `/restart`, `/update` or
     * `/service opencode stop`; the ops page keeps the confirmation dialog so a
     * typed word can never run it without a tap, exactly like Telegram's confirm card.
     */
    var opsConfirmRequested by mutableStateOf<Pair<String, String>?>(null)
        private set

    fun requestOpsConfirm(path: String, label: String) {
        opsConfirmRequested = path to label
        navigate(Screen.Ops)
    }

    fun clearOpsConfirmRequest() {
        opsConfirmRequested = null
    }

    /**
     * `/agents install codex` typed in the chat box. The engine page owns the confirmation
     * dialog, so a word the user typed never installs, updates or removes a CLI by itself —
     * Telegram sends a confirm card for these too, and the server re-checks every guard.
     */
    var agentConfirmRequested by mutableStateOf<Pair<String, String>?>(null)
        private set

    fun requestAgentConfirm(engine: String, action: String) {
        agentConfirmRequested = engine to action
        navigate(Screen.Agents)
    }

    fun clearAgentConfirmRequest() {
        agentConfirmRequested = null
    }

    /**
     * `/cc provider current` typed in the chat box. The console resolves it against the
     * word pairs the server sends (`GET /cc/views` and `GET /cc/exec`), so a destructive
     * one still goes through that page's confirmation dialog rather than running on text.
     */
    var ccRunRequested by mutableStateOf<String?>(null)
        private set

    fun requestCcWords(arg: String) {
        ccRunRequested = arg
        navigate(Screen.Cc)
    }

    fun clearCcRunRequest() {
        ccRunRequested = null
    }

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
            dailyReport = api.usageReport(conn())
            serverInfo = api.info(conn())
        }
    }

    fun refreshHelp() {
        guarded("加载帮助") { loadHelp() }
    }

    /** The help copy and the command list come from one endpoint, so they never drift apart. */
    private suspend fun loadHelp() {
        val view = api.help(conn())
        helpView = view
        botCommands = view.commands
        botAliases = view.aliases
    }

    fun selectHelpSection(id: String) {
        helpSection = id
        if (helpView == null) refreshHelp()
    }

    fun refreshDir() {
        guarded("加载工作目录") { dirInfo = api.dir(conn()) }
    }

    /** Opens the picker on the session's own directory, or wherever the caller names. */
    fun openDirBrowser(path: String? = null) {
        dirBrowseError = null
        loadDir(path ?: dirInfo?.workDir ?: "")
    }

    fun closeDirBrowser() {
        dirBrowse = null
        dirBrowseError = null
    }

    /** Read-only walk of the server's tree; nothing here touches the session. */
    fun loadDir(path: String) {
        if (dirBrowseBusy) return
        dirBrowseBusy = true
        viewModelScope.launch {
            try {
                dirBrowse = api.dirBrowse(conn(), path)
                dirBrowseError = null
            } catch (err: Exception) {
                dirBrowseError =
                    if (err is NotConfiguredException) err.message else "读取目录失败：${err.message}"
            } finally {
                dirBrowseBusy = false
            }
        }
    }

    /** Hands the browsed path to the same call the typed dialog uses, so both agree. */
    fun chooseDir(path: String) {
        closeDirBrowser()
        setWorkDir(path)
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
        guarded("加载队列") {
            queue = api.queue(conn())
            recentTasks = api.tasks(conn()).filterNot { it.isRunning }
        }
    }

    /** Auto-refresh for the queue screen: a flaky link must not paint an error banner. */
    fun pollQueue() {
        viewModelScope.launch {
            try {
                val records = api.tasks(conn())
                queue = api.queue(conn())
                recentTasks = records.filterNot { it.isRunning }
            } catch (_: Exception) {
            }
        }
    }

    fun stopTask(id: String) {
        guarded("停止任务") {
            try {
                api.stopTask(conn(), id)
                toast = "已请求停止"
            } catch (err: ApiException) {
                // The queue list is refreshed asynchronously, so a row can have settled between
                // being drawn and being tapped. That is not an error worth an error banner.
                if (err.code != 409) throw err
                toast = "这条任务已经结束了"
            }
            refreshQueue()
        }
    }

    /** Re-runs one failed or stopped assistant message; the server replays the original prompt. */
    fun retryTask(taskId: String) {
        if (messages.none { it.taskId == taskId }) return
        if (!retrying.add(taskId)) return
        viewModelScope.launch {
            try {
                // the stored task carries attachments and the one-off model pin, which a
                // client-side text copy would silently drop
                val task = api.retryTask(conn(), taskId)
                // The list can change while the request is in flight (新建会话 empties it),
                // so the bubble is located again by task id instead of a captured index.
                val position = messages.indexOfFirst { it.taskId == taskId }
                val replacement = ChatMessage(ChatMessage.Role.ASSISTANT, "", taskId = task.id, status = task.status)
                messages = if (position < 0) {
                    messages + replacement
                } else {
                    messages.toMutableList().also { list -> list[position] = replacement }
                }
                persistMessages()
                pollTask(task.id)
            } catch (err: ApiException) {
                // The server prunes old tasks; then only the local history can help,
                // at the cost of attachments and the model pin
                if (err.code != 404) {
                    connectionError = "重试失败：${err.message}"
                } else {
                    val position = messages.indexOfFirst { it.taskId == taskId }
                    if (position < 0) connectionError = "重试失败：这条消息已不在聊天里"
                    else resendFromHistory(position)
                }
            } catch (err: Exception) {
                connectionError = "重试失败：${err.message}"
            } finally {
                retrying.remove(taskId)
            }
        }
    }

    /**
     * Re-runs a record from the task list. No local bubble points at it, so the server's replay
     * (prompt, attachments and model pin included) comes back as a new one.
     */
    fun retryRecord(taskId: String) {
        if (!retrying.add(taskId)) return
        viewModelScope.launch {
            try {
                val task = api.retryTask(conn(), taskId)
                messages = messages + ChatMessage(
                    ChatMessage.Role.ASSISTANT,
                    "",
                    taskId = task.id,
                    status = task.status,
                )
                persistMessages()
                pollTask(task.id)
                refreshQueue()
            } catch (err: Exception) {
                connectionError = "重试失败：${err.message}"
            } finally {
                retrying.remove(taskId)
            }
        }
    }

    /** Text-only resend of the prompt preceding message [index]. */
    private fun resendFromHistory(index: Int) {
        val prompt = messages.subList(0, index).lastOrNull { it.role == ChatMessage.Role.USER }?.text
        if (prompt.isNullOrBlank()) {
            toast = "没有可重试的任务"
            return
        }
        if (!send(prompt)) toast = "任务执行中，请先等待或停止当前任务"
    }

    /** The button's intent: always drop this session's own model pick. */
    fun resetModel() {
        guarded("恢复默认模型") {
            val message = api.setModel(conn(), "default", reset = true)
            session = api.session(conn())
            toast = message
        }
    }

    /**
     * Sends a typed `/model <word>` untouched: the server owns Telegram's rule, so a word
     * naming a real model switches to it and any other reset word restores the default.
     */
    fun applyModelWord(word: String) {
        val raw = word.trim()
        if (raw.isEmpty()) return
        guarded("切换模型") {
            val message = api.setModel(conn(), raw)
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
    fun refreshPalette() {
        silent {
            aliases = api.aliases(conn())
            // The "/" palette needs the bot's own command words; they ride on /help
            if (botCommands.isEmpty()) loadHelp()
        }
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
                proxyTestMessage = (if (result.ok) "连接正常" else "连接失败") + latency +
                    (result.message?.takeIf { !result.ok }?.let { "：$it" } ?: "")
            } catch (err: Exception) {
                proxyTestMessage = "测试失败：${err.message}"
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
                val release = api.releaseInfo(conn())
                releaseInfo = release.release
                startupCheck = release.startup
            } catch (err: Exception) {
                connectionError = "加载诊断失败：${err.message}"
            } finally {
                opsBusy = false
            }
        }
    }

    fun refreshAndroidRelease() {
        viewModelScope.launch {
            appUpdateError = null
            try {
                androidRelease = api.androidRelease(conn(), appVersionCode.toInt())
            } catch (err: Exception) {
                appUpdateError = "检查更新失败：${err.message}"
            }
        }
    }

    /**
     * Downloads, verifies and opens the system installer. A debug build and a release build
     * carry different signatures, so replacing one with the other requires an uninstall and
     * loses this phone's local settings; the server never hides that constraint.
     */
    fun downloadAndInstallAppUpdate() {
        if (appUpdateStage != null) return
        val release = androidRelease ?: return
        val versionCode = release.versionCode ?: return
        val sha256 = release.sha256?.lowercase()
        if (!release.configured || sha256 == null || !Regex("^[0-9a-f]{64}$").matches(sha256)) {
            appUpdateError = "服务器没有提供可校验的 APK 清单"
            return
        }
        if (versionCode <= appVersionCode) {
            appUpdateError = "当前已是最新版本（${appVersionName.ifBlank { appVersionCode.toString() }}）"
            return
        }
        viewModelScope.launch {
            appUpdateError = null
            appUpdateStage = "下载中"
            try {
                val dir = File(appContext.cacheDir, "updates")
                dir.mkdirs()
                val apk = File(dir, "agent-bot-v${release.versionName ?: versionCode}.apk")
                // Always fetch a newly published build; a cached file with the same name
                // could belong to a previous manifest with a different checksum.
                if (apk.exists()) apk.delete()
                val downloaded = api.downloadAndroidRelease(conn(), apk, release.size)
                appUpdateStage = "校验中"
                val actual = withContext(Dispatchers.IO) { sha256Of(downloaded) }
                if (actual != sha256) {
                    downloaded.delete()
                    throw ApiException(0, "APK 校验失败：SHA-256 与清单不一致，已删除下载文件")
                }
                // Manifest size is optional (0 means unknown), but an APK produced by the
                // release pipeline is never empty. Refuse a zero-byte cache hit too, otherwise
                // a failed earlier download could reach the installer without a hash mismatch.
                if (downloaded.length() <= 0) {
                    downloaded.delete()
                    throw ApiException(0, "APK 下载为空，已删除文件")
                }
                appUpdateStage = "安装中"
                openInstaller(downloaded)
            } catch (err: ActivityNotFoundException) {
                appUpdateError = "没有可用的 APK 安装器，请允许浏览器/文件管理器安装应用"
            } catch (err: Exception) {
                appUpdateError = "应用更新失败：${err.message}"
            } finally {
                appUpdateStage = null
            }
        }
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun openInstaller(apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !appContext.packageManager.canRequestPackageInstalls()
        ) {
            appUpdateError = "请先允许本应用安装未知来源应用，返回设置页后再次点击「下载并安装」"
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${appContext.packageName}"))
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            appContext.startActivity(settings)
            return
        }
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        appContext.startActivity(intent)
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
                toast = result.message ?: "${label}完成"
                if (path.startsWith("service")) refreshOpsService()
            } catch (err: Exception) {
                // A restart may kill the process that is answering this request
                if (path == "restart") toast = "已发送重启指令（连接可能短暂中断，稍后刷新）"
                else connectionError = "${label}失败：${err.message}"
            } finally {
                opsActionBusy = null
            }
        }
    }

    fun clearOpsResult() {
        opsResult = null
    }

    /** 干跑检查更新：与 Telegram「🔍 检查更新」一致，不改动服务器工作区。 */
    fun checkForUpdates() {
        if (opsActionBusy != null) return
        viewModelScope.launch {
            opsActionBusy = "检查更新"
            try {
                val result = api.checkUpdate(conn())
                opsResult = result
                toast = result.message ?: "检查完成"
            } catch (err: Exception) {
                connectionError = "检查更新失败：${err.message}"
            } finally {
                opsActionBusy = null
            }
        }
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
        guarded("切换引擎") { applyEngine(engine) }
    }

    private suspend fun applyEngine(engine: String) {
        val result = api.switchAgent(conn(), engine)
        session = result.session
        // The server's own note covers "already on this engine" and a missing CLI binary
        toast = result.message ?: "已切换到 ${result.session.engineLabel ?: engine}"
        refreshModels()
    }

    /** `/agent <id>` resolves against the server's engine list, the way Telegram's `/agent` does. */
    fun switchAgentByQuery(query: String) {
        val wanted = query.trim().lowercase()
        guarded("切换引擎") {
            if (agents.isEmpty()) agents = api.agents(conn())
            val hit = agents.matchEngine(wanted)
            if (hit == null) {
                val ids = agents.map { it.id }
                // An older server does not list the built-in engine, so always name it
                val choices = if ("opencode" in ids) ids else ids + "opencode"
                connectionError = "未识别的 Agent 引擎：$query，可选：${choices.joinToString("、")}"
            } else {
                applyEngine(hit.id)
            }
        }
    }

    fun setModel(model: ModelEntry) {
        guarded("切换模型") { applyModel(model) }
    }

    private suspend fun applyModel(model: ModelEntry) {
        val message = api.setModel(conn(), model.value)
        session = api.session(conn())
        toast = message
    }

    /** `/model <id|label>` picks a listed model, matching the same words Telegram accepts. */
    fun selectModelByQuery(query: String) {
        val wanted = query.trim().lowercase()
        guarded("切换模型") {
            if (modelChoices.models.isEmpty()) modelChoices = api.models(conn())
            val hit = modelChoices.models.matchModel(wanted)
            if (hit == null) {
                connectionError = modelMissMessage(modelChoices, query)
            } else {
                applyModel(hit)
            }
        }
    }

    /** Telegram's refusal for a `/model <word>` that lands on nothing, worded per engine. */
    private fun modelMissMessage(choices: ModelChoices, query: String): String {
        if (choices.models.isNotEmpty()) {
            return "未找到模型：$query，可选：${choices.models.joinToString("、") { it.label }}"
        }
        return choices.modelHint?.let {
            "该引擎的模型由 CLI 自身配置，可用提示：$it（也可发送 /model <模型ID>）"
        } ?: "该引擎不支持通过 Bot 切换模型，可在「引擎管理」改用 OpenCode，或在 CLI 配置中设置。"
    }

    /** `/engine <id>` pins the next message to a CLI engine without touching the session. */
    fun pinEngineByQuery(query: String) {
        val wanted = query.trim().lowercase()
        if (wanted == "opencode") {
            // The built-in engine is listed now, but a pin only means "use something else",
            // so asking for OpenCode clears it rather than pinning its id
            updateOneOffEngine(null)
            toast = "下一条消息交给 OpenCode"
            return
        }
        guarded("设置一次性引擎") {
            if (agents.isEmpty()) agents = api.agents(conn())
            val hit = agents.matchEngine(wanted)
            if (hit == null) {
                connectionError = "未识别的 Agent 引擎：$query"
            } else {
                updateOneOffEngine(hit.id)
                toast = "下一条消息交给 ${hit.label}"
            }
        }
    }

    /** `/model! <id|label>` pins the next message's model for the pinned engine. */
    fun pinModelByQuery(query: String) {
        val wanted = query.trim().lowercase()
        val local = if (oneOffEngine != null) oneOffChoices else modelChoices
        local.models.matchModel(wanted)?.let {
            updateOneOffModel(it.value)
            toast = "下一条消息的模型：${it.label}"
            return
        }
        guarded("设置一次性模型") {
            val choices = api.models(conn(), oneOffEngine ?: session?.engine)
            if (oneOffEngine != null) {
                oneOffChoices = choices
            } else {
                modelChoices = choices
            }
            val hit = choices.models.matchModel(wanted)
            // A CLI that lists nothing but names a format takes the word as typed, like Telegram
            val raw = query.trim()
            if (hit != null) {
                updateOneOffModel(hit.value)
                toast = "下一条消息的模型：${hit.label}"
            } else if (choices.models.isEmpty() && choices.modelHint != null) {
                updateOneOffModel(raw)
                toast = "下一条消息的模型：$raw"
            } else {
                connectionError = modelMissMessage(choices, query)
            }
        }
    }

    fun newChat() {
        // The server refuses a reset while a task runs (409, like Telegram's button); checking
        // here avoids a pointless request and gives the user the same actionable message.
        if (hasLiveTask) {
            toast = "任务执行中，请先停止当前任务再开启新会话"
            return
        }
        guarded("新会话") {
            api.newSession(conn())
            session = api.session(conn())
            // Only clear the local transcript after the server accepted the reset. Clearing first
            // left the user staring at an empty chat when the request failed, while the server still
            // held the old context.
            messages = emptyList()
            mediaImages = emptyMap()
            mediaErrors = emptySet()
            // Trailing history writes are the only writer of the stored chat, so the reset goes
            // through them too: calling clearMessages here could be overtaken by an in-flight
            // snapshot and bring the old bubbles back on the next launch.
            persistMessages()
            toast = "已开启新会话"
        }
    }

    /**
     * Runs a typed `/command [args]` line the way Telegram's router does, so arguments
     * no longer turn a command into an AI prompt. Returns false when the word is not one
     * the bot lists — then the text is a prompt (or a user shortcut for the server to expand).
     */
    fun runSlash(raw: String): Boolean {
        val line = raw.trim()
        if (!line.startsWith("/")) return false
        val parts = line.split(SLASH_SPACES)
        val word = parts.first().removePrefix("/").substringBefore("@").lowercase()
        if (word.isEmpty()) return false
        val arg = parts.drop(1).joinToString(" ").trim()
        if (word in ONE_OFF_WORDS) return applyOneOffSlashCommand(this, word, arg)
        val name = botAliases[word] ?: word
        // An outdated server may not send the list yet, so the App's own table counts as known too
        if (!(name in SLASH_COMMANDS || botCommands.any { it.command == name })) return false
        applySlashCommand(this, name, arg)
        return true
    }

    /** Asks the chat screen to open the one-off engine/model picker (a bare `/engine` or `/model!`). */
    var pinPickerRequested by mutableStateOf(false)
        private set

    fun requestPinPicker() {
        pinPickerRequested = true
    }

    fun clearPinPickerRequest() {
        pinPickerRequested = false
    }

    /** Queues a prompt; returns false when it was rejected (busy or empty). */
    fun send(text: String): Boolean {
        val raw = text.trim()
        // A bot command typed with arguments is executed, not sent to the AI, exactly
        // as Telegram's router does. Unknown words fall through as prompts.
        if (raw.startsWith("/") && runSlash(raw)) return true
        if (busy) return false
        val attachments = pendingAttachments
        val engine = oneOffEngine
        val model = oneOffModel
        if (raw.isEmpty() && attachments.isEmpty()) return false
        // busy 在 launch 外置位:协程要等调度才跑,窗口内快速连发会双双通过检查
        busy = true
        viewModelScope.launch {
            try {
                // `/name` shortcuts expand server-side with the bot's 3-hop rule, so submit as typed.
                val task = api.submitTask(conn(), raw, attachments, engine, model)
                oneOffEngine = null
                oneOffModel = null
                oneOffChoices = ModelChoices()
                // Only the files this request actually carried. Clearing the strip instead would
                // silently drop an attachment the user picked while a 10 MB upload was in flight.
                pendingAttachments = pendingAttachments.filterNot { staged -> attachments.any { it === staged } }
                val sentAt = System.currentTimeMillis()
                val sent = attachments.map { SentAttachment(it.name, it.mime, it.sizeBytes) }
                messages = messages + ChatMessage(ChatMessage.Role.USER, raw, at = sentAt, attachments = sent) +
                    ChatMessage(ChatMessage.Role.ASSISTANT, "", taskId = task.id, status = task.status, at = sentAt)
                persistMessages()
                pollTask(task.id)
            } catch (err: Exception) {
                connectionError = "发送失败：${err.message}"
                // Give the text back so a dropped connection never eats the prompt.
                if (draft.isBlank()) updateDraft(raw)
                // ...and keep the one-off pins so a plain retry repeats the same request.
                oneOffEngine = engine
                oneOffModel = model
            } finally {
                busy = false
            }
        }
        return true
    }

    /**
     * Re-runs the last task whatever its outcome, which is Telegram's `/retry`: a good answer
     * is replayable just as easily as a broken one. Picking the task id means the server
     * resubmits the original prompt with its attachments and model pin, so unlike a local
     * text resend the retry is never silently degraded.
     */
    fun retryLastTask() {
        val last = messages.lastOrNull { it.role == ChatMessage.Role.ASSISTANT && it.taskId != null }
        if (last?.taskId != null) {
            if (last.status == "queued" || last.status == "running") {
                toast = "上一条任务还在执行，请先停止或等待"
                return
            }
            retryTask(last.taskId)
            return
        }
        // Only a task the server no longer remembers has to be rebuilt from local history
        val lastUser = messages.lastOrNull { it.role == ChatMessage.Role.USER }
        if (lastUser == null || lastUser.text.isBlank()) {
            toast = "没有可重试的任务"
            return
        }
        if (!send(lastUser.text)) toast = "任务执行中，请先等待或停止当前任务"
    }

    /**
     * The error banner's 重试. The banner is global, so most of what reaches it has nothing to do
     * with the last task: an attachment that could not be read, a screen that failed to load, a
     * send that never left the phone. Replaying the newest task for those started a second, fully
     * billed Agent run whose answer the user had not asked for, so the retry is limited to the one
     * case where the last task really is the thing that broke.
     */
    fun retryFromBanner() {
        val last = messages.lastOrNull { it.role == ChatMessage.Role.ASSISTANT && it.taskId != null }
        connectionError = null
        if (last?.status == "failed" || last?.status == "cancelled") retryLastTask()
    }

    fun stop() {
        guarded("停止") {
            // Say what actually happened. Reporting success when the queue was empty — or when a
            // non-interruptible /cc job holds it — left the user believing the cloud agent had
            // stopped, with the task still running and burning tokens.
            val stopped = api.stopTasks(conn())
            if (screen == Screen.Queue) refreshQueue()
            toast = if (stopped.isEmpty()) "当前没有正在执行或排队中的任务可停止" else "已请求停止 ${stopped.size} 条任务"
        }
    }

    private fun pollTask(id: String) {
        if (polls.containsKey(id)) return
        polls[id] = viewModelScope.launch {
            try {
                try {
                    // Preferred path: the SSE stream pushes every progress line and
                    // the terminal snapshot with no polling delay. Frames arrive on OkHttp's
                    // reader thread, so every chat write hops back to Main first.
                    api.streamTask(conn(), id) { task ->
                        withContext(Dispatchers.Main) { applyTaskSnapshot(id, task) }
                    }
                    return@launch
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    // Missing endpoint, broken stream or auth hiccup: polling is the
                    // authoritative fallback and produces the real error messages
                }
                pollTaskLoop(id)
            } catch (err: CancellationException) {
                // Leaving the Activity cancels this job while the task keeps running server-side.
                // Reporting that as a failure would write "任务查询中断" into the saved chat over
                // a bubble that is still 运行中, and the resume-on-launch only re-attaches to
                // queued/running rows, so the real answer would be lost for good.
                throw err
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
                // Task records live in memory, so a bot that restarted has forgotten even a run
                // that finished while the App was away. Nothing more will arrive: settle the
                // bubble as stopped — which offers 重新执行 — instead of inventing a failure.
                if (err.code == 404) {
                    updateMessage(id) {
                        it.copy(
                            status = "cancelled",
                            progress = null,
                            text = it.text.ifEmpty { "服务器已重启，这条任务的结果找不回来了" },
                        )
                    }
                    return
                }
                // A 401 means the saved token stopped matching the server — it regenerates when
                // the token file is missing, i.e. after a reinstall or a wiped data dir, and the
                // bot may also have moved to another host. The task itself is untouched and
                // conn() re-reads the stored settings on every pass, so backing off lets this
                // loop collect the answer as soon as the user re-pairs. Marking the bubble failed
                // would lose it for good: the resume-on-launch only re-attaches to live rows.
                if (err.code == 401) {
                    networkFailures++
                    updateMessage(id) { it.copy(progress = "访问令牌已失效，在「设置」重新配对后这条任务会自动继续…") }
                    delay(minOf(3_000L * networkFailures, 15_000L))
                    continue
                }
                // A bot reached through nginx, a tunnel or a VPN answers 502/503/504 (and a proxy's
                // 429) while it is restarting or briefly unreachable. The task is still running
                // server-side, exactly like a dropped socket, so back off and keep asking instead of
                // painting a proxy error page onto a bubble that will succeed a moment later.
                if (err.code >= 500 || err.code == 408 || err.code == 429) {
                    networkFailures++
                    updateMessage(id) { it.copy(progress = "服务暂不可用，正在重试…") }
                    delay(minOf(3_000L * networkFailures, 15_000L))
                    continue
                }
                // Code 0 is a reply this phone could not read at all (a body that would not
                // decrypt, a 200 that was not the JSON object the endpoint promises). The task is
                // still running server-side, so asking again is right — but bounded, since unlike
                // a proxy hiccup this one does not heal itself and an endless loop would settle
                // nothing while it hammered the server.
                if (err.code == 0 && networkFailures < MAX_LOCAL_POLL_RETRIES) {
                    networkFailures++
                    updateMessage(id) { it.copy(progress = "读取任务状态失败，正在重试…") }
                    delay(minOf(3_000L * networkFailures, 15_000L))
                    continue
                }
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
        // Called from Main on every SSE progress frame; encoding the whole chat there is how a
        // long history starts janking the bubble list, and a SharedPreferences commit rewrites the
        // file with it, so the newest snapshot goes to the writer and returns immediately.
        historyWrites.trySend(messages)
    }

    /** Downloads and decodes one reply image; the bubble calls this from LaunchedEffect. */
    fun loadMediaImage(taskId: String, media: TaskMedia, retry: Boolean = false) {
        val key = "$taskId/${media.index}"
        if (retry) mediaErrors = mediaErrors - key
        if (mediaImages.containsKey(key) || mediaErrors.contains(key) || !mediaLoads.add(key)) return
        viewModelScope.launch {
            try {
                val file = mediaFile(taskId, media)
                val bitmap = withContext(Dispatchers.IO) { decodeMediaFile(file) }
                if (bitmap != null) {
                    // A decoded image costs ~10MB of heap, so only the newest few stay cached;
                    // scrolling back re-decodes the ones that left.
                    mediaImages = (mediaImages + (key to bitmap)).let { cached ->
                        if (cached.size <= MAX_MEDIA_IMAGES) cached
                        else cached.entries.drop(cached.size - MAX_MEDIA_IMAGES).associate { it.key to it.value }
                    }
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

    /** 把每日报告文本交给系统分享面板（发给联系人、邮件或剪贴板均可）。 */
    fun shareReport() {
        val report = dailyReport ?: run {
            toast = "报告尚未加载，请先打开状态页"
            return
        }
        val text = report.text.ifBlank {
            listOf(
                "每日报告 · ${report.day}",
                "今日任务：${report.totals.tasks} 次",
                "近 7 天合计：${report.trendTasks} 次",
            ).joinToString("\n")
        }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TITLE, "Agent Bot 每日报告")
            putExtra(Intent.EXTRA_TEXT, text)
        }
        appContext.startActivity(
            Intent.createChooser(send, "分享每日报告").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** 下载服务端数据备份（data 目录各 JSON 状态的 tar.gz）并交给系统分享面板保存。 */
    fun shareBackup() {
        viewModelScope.launch {
            try {
                val bytes = api.backupData(conn())
                val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmssSSS", java.util.Locale.US).format(java.util.Date())
                val dir = java.io.File(appContext.cacheDir, "backup").apply { mkdirs() }
                val file = java.io.File(dir, "agentbot-backup-$stamp.tar.gz")
                file.writeBytes(bytes)
                // 分享面板只读最新一份；旧归档留给系统回收，最多保留 3 份防止缓存膨胀
                dir.listFiles { f -> f.name.startsWith("agentbot-backup-") }
                    ?.sortedByDescending { it.name }
                    ?.drop(3)
                    ?.forEach { it.delete() }
                val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", file)
                val share = Intent(Intent.ACTION_SEND).setType("application/gzip")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                appContext.startActivity(
                    Intent.createChooser(share, "数据备份").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                toast = "备份已生成（${bytes.size / 1024} KB），请在分享面板选择保存位置"
            } catch (err: Exception) {
                connectionError = "备份失败：${err.message}"
            }
        }
    }

    /** Hands one reply media item to an external viewer; falls back to the share sheet. */
    fun openMedia(taskId: String, media: TaskMedia) {
        viewModelScope.launch {
            try {
                val file = mediaFile(taskId, media)
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

    /** Reply media on disk, downloaded once and reused after a restart; nothing is held in the heap. */
    private suspend fun mediaFile(taskId: String, media: TaskMedia): File {
        val file = MediaCache.file(appContext, taskId, media.index, media.name)
        if (file.isFile && file.length() > 0) return file
        return api.taskMediaTo(conn(), taskId, media.index, file)
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

    /** 延后一条待触发提醒，并立即同步刷新列表时间。 */
    fun snoozeReminder(id: Long, minutes: Int) {
        guarded("延后提醒") {
            api.snoozeReminder(conn(), id, minutes)
            refreshReminders()
            toast = "已延后 $minutes 分钟，列表已同步"
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
        /** Decoded reply images kept in memory at once; each one costs roughly 10MB of heap. */
        private const val MAX_MEDIA_IMAGES = 8

        /**
         * Minimum spacing between two history writes. A running task pushes a progress frame every
         * few tens of milliseconds, and the stored chat only has to be recent enough to survive a
         * process death — re-encoding it per frame buys nothing.
         */
        private const val HISTORY_WRITE_DELAY_MS = 250L

        /** Drafts pace themselves the same way, looser because typing is a burst of one field. */
        private const val DRAFT_WRITE_DELAY_MS = 400L

        /** How long a live task keeps being asked about after replies this phone cannot read. */
        private const val MAX_LOCAL_POLL_RETRIES = 8

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
