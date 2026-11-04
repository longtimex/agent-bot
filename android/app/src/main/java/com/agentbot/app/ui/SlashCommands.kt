package com.agentbot.app.ui

import com.agentbot.app.data.AgentInfo
import com.agentbot.app.data.CcExecCommand
import com.agentbot.app.data.CcViewSpec
import com.agentbot.app.data.ModelEntry

/** Telegram splits a command line on any run of whitespace; do the same here. */
internal val SLASH_SPACES = Regex("\\s+")

/** App-only pin words: they are not bot commands, so they resolve before aliases do. */
internal val ONE_OFF_WORDS = setOf("engine", "engine!", "model!")

/**
 * Command words the App answers on its own. The server also sends its list, and a name
 * only there still lands on the screen that holds the feature, so a word the bot knows
 * is never submitted to the AI as a prompt.
 */
internal val SLASH_COMMANDS = setOf(
    "start", "menu", "help", "new", "stop", "retry", "queue", "history", "export",
    "status", "usage", "report", "id", "api", "agent", "agents", "model", "dir", "timezone",
    "remind", "reminders", "cancel", "schedule", "env", "access", "alias", "proxy",
    "cc", "ops", "logs", "diag", "update", "restart", "service",
)

/** Telegram's words for dropping the session's model pick. */
private val MODEL_DEFAULT_WORDS = setOf("default", "reset", "clear", "auto", "默认", "恢复默认")

/** Telegram compares the trimmed, lowercased word; the Chinese spellings are unaffected by casing. */
private fun isResetWord(arg: String): Boolean = arg.trim().lowercase() in MODEL_DEFAULT_WORDS

/** Words that mean "drop this pick" for the session model, the queue and a one-off pin. */
private val CLEAR_WORDS = setOf("clear", "off", "reset", "default", "取消", "清空", "默认")

/** Telegram clamps `/logs` to this window, and the server clamps the same way. */
private const val LOG_LINES_MIN = 10
private const val LOG_LINES_MAX = 400

/** Telegram's `/export` format words, mapped to what `GET /export?format=` accepts. */
private val EXPORT_FORMATS = mapOf(
    "md" to "markdown",
    "markdown" to "markdown",
    "json" to "json",
)

/** Telegram's `/help` accepts these section words. */
private val HELP_SECTIONS = mapOf(
    "" to "basic",
    "basic" to "basic",
    "简版" to "basic",
    "full" to "full",
    "all" to "full",
    "完整" to "full",
    "cc" to "cc",
    "cc-switch" to "cc",
)

/**
 * A run of `/cc` words the server's tables recognized, plus whatever target followed it.
 * The console owns both outcomes: a [View] loads read-only output straight away, an
 * [Exec] may still need its confirmation dialog before anything reaches cc-switch.
 */
internal sealed class CcQuery {
    class View(val view: CcViewSpec, val target: String?) : CcQuery()
    class Exec(val command: CcExecCommand, val target: String?) : CcQuery()
}

/**
 * Resolves `provider del foo` against the word runs the server ships. The longest run
 * wins first, so `skills repos add owner/name` reads the third word as part of the
 * command rather than as its target. When one run belongs to both a target-taking and a
 * targetless entry (`skills update`), the words that follow decide, and a read-only view
 * beats a write on any other tie.
 */
internal fun matchCcQuery(
    arg: String,
    views: List<CcViewSpec>,
    commands: List<CcExecCommand>,
): CcQuery? {
    val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
    if (words.size < 2) return null
    for (size in minOf(3, words.size) downTo 2) {
        val head = words.take(size).joinToString(" ").lowercase()
        val tail = words.drop(size).joinToString(" ").ifBlank { null }
        val wantsTarget = tail != null
        val view = views.find { head in it.tokens && it.needsTarget == wantsTarget }
            ?: views.find { head in it.tokens }
        val command = commands.find { head in it.tokens && it.needsTarget == wantsTarget }
            ?: commands.find { head in it.tokens }
        val match = when {
            view != null -> CcQuery.View(view, if (view.needsTarget) tail else null)
            command != null -> CcQuery.Exec(command, if (command.needsTarget) tail else null)
            else -> null
        }
        if (match != null) return match
    }
    return null
}

/**
 * The argv Telegram hands to cc-switch for `/cc run provider list`: one entry per word, and
 * the leading `run` word is Telegram's own, so it never reaches the CLI.
 */
internal fun ccRawArgv(words: String): List<String> =
    words.split(SLASH_SPACES).filter { it.isNotBlank() }
        .let { if (it.firstOrNull()?.lowercase() == "run") it.drop(1) else it }

/**
 * Runs one resolved bot command, mirroring the argument grammar Telegram accepts.
 * Anything the App can only do with a control (installs, restarts, cc-switch writes)
 * opens the page that holds it; the words the user typed prefill that page's own
 * confirmation dialog, so no mutation ever happens on text alone.
 */
internal fun applySlashCommand(vm: AppViewModel, name: String, arg: String) {
    when (name) {
        "start", "menu" -> {
            vm.selectHelpSection("basic")
            vm.navigate(Screen.Help)
        }

        "help" -> {
            val section = HELP_SECTIONS[arg.lowercase()]
            if (arg.isNotEmpty() && section == null) vm.showToast("帮助只有「完整说明」和「cc-switch 指令」两页")
            vm.selectHelpSection(section ?: if (arg.isEmpty()) vm.helpSection else "basic")
            vm.navigate(Screen.Help)
        }

        "new" -> vm.newChat()
        "stop" -> vm.stop()
        "retry" -> vm.retryLastTask()

        "queue" -> if (arg.lowercase() in CLEAR_WORDS) vm.clearQueue() else vm.navigate(Screen.Queue)

        "history" -> {
            // The server's window stops at 50 rows, so say so instead of quietly showing fewer
            arg.toIntOrNull()?.let { count ->
                val limit = count.coerceIn(1, 50)
                if (limit != count) vm.showToast("历史窗口最多 50 条，已按 $limit 条显示")
                vm.updateHistoryLimit(limit)
            }
            vm.navigate(Screen.History)
        }

        "export" -> {
            val format = EXPORT_FORMATS[arg.lowercase()]
            when {
                arg.isEmpty() -> vm.navigate(Screen.History)
                format == null -> vm.showToast("用法：/export markdown 或 /export json")
                else -> vm.requestExport(format)
            }
        }

        "status" -> vm.navigate(Screen.Status)
        "usage" -> vm.navigate(Screen.Status)
        "report" -> vm.navigate(Screen.Status)
        "id" -> vm.navigate(Screen.Status)
        "api" -> vm.navigate(Screen.Settings)

        "agent" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            val action = agentActionWord(words.firstOrNull())
            when {
                action != null && words.size >= 2 -> vm.requestAgentConfirm(words[1].lowercase(), action)
                action != null -> vm.navigate(Screen.Agents)
                arg.isBlank() -> vm.navigate(Screen.Agents)
                else -> vm.switchAgentByQuery(arg)
            }
        }

        "agents" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            val action = agentActionWord(words.firstOrNull())
            when {
                words.isEmpty() -> vm.navigate(Screen.Agents)
                action == null -> {
                    vm.navigate(Screen.Agents)
                    vm.showToast("用法：/agents install|update|uninstall <引擎 id>")
                }
                words.size < 2 -> vm.navigate(Screen.Agents)
                else -> vm.requestAgentConfirm(words[1].lowercase(), action)
            }
        }

        "model" -> when {
            arg.isBlank() -> vm.navigate(Screen.Session)
            // Reset words go to the server, which owns Telegram's rule: a model really
            // named `auto` stays reachable, anything else restores the default
            isResetWord(arg) -> vm.applyModelWord(arg)
            else -> vm.selectModelByQuery(arg)
        }

        "dir" -> when {
            arg.isBlank() -> vm.navigate(Screen.Session)
            arg.lowercase() in CLEAR_WORDS -> vm.resetWorkDir()
            else -> vm.setWorkDir(arg)
        }

        "timezone" -> if (arg.isBlank()) vm.navigate(Screen.Session) else vm.changeTimezone(arg)

        "remind" -> if (arg.isBlank()) vm.navigate(Screen.Reminders) else vm.addReminder(arg)
        "reminders" -> vm.navigate(Screen.Reminders)
        "cancel" -> {
            val id = arg.trim().toLongOrNull()
            if (id == null || id <= 0) {
                vm.showToast("用法：/cancel 编号（编号见提醒页）")
                vm.navigate(Screen.Reminders)
            } else {
                vm.deleteReminder(id)
            }
        }

        "schedule" -> {
            val rest = arg.removePrefix("add").trim()
            if ((arg.startsWith("add") || arg.startsWith("新增")) && rest.isNotBlank()) {
                vm.addSchedule(rest)
            } else {
                vm.navigate(Screen.Schedules)
            }
        }

        "env" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            when (words.firstOrNull()?.lowercase()) {
                null, "list", "show" -> vm.navigate(Screen.Config)
                "set" -> if (words.size >= 3) {
                    vm.setConfig(words[1], words.drop(2).joinToString(" "))
                } else {
                    vm.showToast("用法：/env set KEY 值")
                }
                "unset", "del", "delete", "remove" -> if (words.size >= 2) {
                    vm.unsetConfig(words[1])
                } else {
                    vm.showToast("用法：/env unset KEY")
                }
                else -> vm.navigate(Screen.Config)
            }
        }

        "access" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            when (words.firstOrNull()?.lowercase()) {
                "add" -> if (words.size >= 2) vm.addAccess(words[1].removePrefix("@")) else vm.navigate(Screen.Access)
                "del", "delete", "remove" ->
                    if (words.size >= 2) vm.removeAccess(words[1].removePrefix("@")) else vm.navigate(Screen.Access)
                else -> vm.navigate(Screen.Access)
            }
        }

        "alias" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            when (words.firstOrNull()?.lowercase()) {
                "add", "新增" -> if (words.size >= 3) {
                    vm.addAlias(words.drop(1).joinToString(" "))
                } else {
                    vm.showToast("用法：/alias add 名称 指令内容")
                }
                "del", "delete", "remove", "rm" ->
                    if (words.size >= 2) vm.deleteAlias(words[1].removePrefix("/")) else vm.navigate(Screen.Aliases)
                else -> vm.navigate(Screen.Aliases)
            }
        }

        "proxy" -> {
            val words = arg.split(SLASH_SPACES).filter { it.isNotBlank() }
            val action = words.firstOrNull()?.lowercase().orEmpty()
            val id = words.getOrNull(1)?.toIntOrNull()?.takeIf { it > 0 }
            vm.navigate(Screen.Proxy)
            when (action) {
                "" -> Unit
                "add" ->
                    if (words.size >= 2) vm.addProxy(words.drop(1).joinToString(" "))
                    else vm.showToast("用法：/proxy add http://127.0.0.1:7890 本地代理")
                "use" -> if (id != null) vm.useProxy(id) else vm.showToast("用法：/proxy use 编号（编号见代理页）")
                "test" -> if (id != null) vm.testProxy(id) else vm.showToast("用法：/proxy test 编号（编号见代理页）")
                "del", "delete", "remove" ->
                    if (id != null) vm.removeProxy(id) else vm.showToast("用法：/proxy del 编号（编号见代理页）")
                "off", "disable", "stop" -> vm.disableProxy()
                else -> vm.showToast("用法：/proxy add <地址> [名称] · use/test/del <编号> · off")
            }
        }

        "cc" -> {
            // The console resolves the words against the server's tables (see matchCcQuery)
            if (arg.isBlank()) vm.navigate(Screen.Cc) else vm.requestCcWords(arg.trim())
        }

        // Telegram reads `/logs` tokens in any order and ignores the ones it does not know
        "logs" -> {
            var source: String? = null
            var lines: Int? = null
            for (token in arg.split(SLASH_SPACES).filter { it.isNotBlank() }) {
                val word = token.lowercase()
                when {
                    word == "opencode" || word == "oc" -> source = "opencode"
                    word == "bot" -> source = "bot"
                    token.all { it.isDigit() } -> lines =
                        // Telegram clamps instead of rejecting; a number too big for an Int
                        // becomes the biggest window it allows, as the server does
                        token.toLongOrNull()?.coerceIn(LOG_LINES_MIN.toLong(), LOG_LINES_MAX.toLong())?.toInt()
                            ?: LOG_LINES_MAX
                }
            }
            vm.navigate(Screen.Ops)
            vm.refreshLogs(source ?: vm.logSource, lines ?: vm.logLines)
        }

        "ops", "diag" -> vm.navigate(Screen.Ops)

        // Telegram never runs these on a typed word: it sends a confirm card, so neither does the App
        "update" -> vm.requestOpsConfirm("update", "更新项目")

        "restart" -> vm.requestOpsConfirm("restart", "重启 Bot")

        "service" -> {
            val verb = (arg.split(SLASH_SPACES).filter { it.isNotBlank() } - "opencode")
                .firstOrNull()?.lowercase()
            when (verb) {
                null, "status" -> {
                    vm.navigate(Screen.Ops)
                    vm.refreshOpsService()
                }

                "start" -> {
                    vm.navigate(Screen.Ops)
                    vm.runOpsAction("service/start", "启动 OpenCode")
                }

                "stop" -> vm.requestOpsConfirm("service/stop", "停止 OpenCode")
                "restart" -> vm.requestOpsConfirm("service/restart", "重启 OpenCode")
                else -> {
                    vm.navigate(Screen.Ops)
                    vm.showToast("用法：/service opencode start|stop|restart")
                }
            }
        }

        else -> vm.showToast("该命令由服务端处理，请在 Telegram 使用 /$name")
    }
}

/**
 * One-off engine/model pins typed into the chat box, e.g. `/engine claude` pins the
 * next message and `/model! sonnet` pins its model. `POST /task` carries both overrides,
 * which Telegram's chat never needs: its `/agent` and `/model` are session-level.
 */
internal fun applyOneOffSlashCommand(vm: AppViewModel, name: String, arg: String): Boolean = when (name) {
    "engine", "engine!" -> when {
        arg.isBlank() -> {
            vm.requestPinPicker()
            true
        }
        name == "engine" && arg.lowercase() in CLEAR_WORDS -> {
            vm.updateOneOffEngine(null)
            true
        }
        else -> {
            vm.pinEngineByQuery(arg)
            true
        }
    }

    "model!" -> when {
        arg.isBlank() -> {
            vm.requestPinPicker()
            true
        }
        isResetWord(arg) && vm.oneOffModels.matchModel(arg.trim().lowercase()) == null -> {
            vm.updateOneOffModel(null)
            true
        }
        else -> {
            vm.pinModelByQuery(arg)
            true
        }
    }

    else -> false
}

/** Telegram's `/agent` and `/agents` share these words for the three managed actions. */
private fun agentActionWord(word: String?): String? = when (word?.lowercase()) {
    "install", "add" -> "install"
    "update", "upgrade" -> "update"
    "uninstall", "remove", "del", "delete" -> "uninstall"
    else -> null
}

/** Engines are addressed by id, display label or alias, case-insensitively like the registry. */
internal fun List<AgentInfo>.matchEngine(word: String): AgentInfo? = firstOrNull {
    it.id.lowercase() == word || it.label.lowercase() == word ||
        it.bin?.lowercase() == word || it.aliases.any { alias -> alias.lowercase() == word }
}

/** Telegram matches a `/model` word against the entry's id, registry key, label or alias. */
internal fun List<ModelEntry>.matchModel(word: String): ModelEntry? = firstOrNull {
    it.id?.lowercase() == word || it.key?.lowercase() == word ||
        it.value.lowercase() == word || it.label.lowercase() == word ||
        it.aliases.any { alias -> alias.lowercase() == word }
}
