package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.InstallDesktop
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.CcExecCommand
import com.agentbot.app.data.CcProvider
import com.agentbot.app.data.CcProviderDraft
import com.agentbot.app.data.CcProviderMeta
import com.agentbot.app.data.CcStatus
import com.agentbot.app.data.CcViewSpec
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * Telegram's `/cc` console. Read views plus typed write routes; the mutating
 * commands are listed by the server (`GET /cc/exec`), and free-form `/cc run`
 * arguments stay Telegram-only on purpose. Words typed in the chat box are
 * resolved here, against the same server list.
 */
@Composable
fun CcScreen(vm: AppViewModel) {
    var confirmUse by remember { mutableStateOf<CcProvider?>(null) }
    var activatingPrompt by remember { mutableStateOf(false) }
    var importingMcp by remember { mutableStateOf(false) }
    var creatingPrompt by remember { mutableStateOf(false) }
    var creatingProvider by remember { mutableStateOf(false) }
    var awaitingTarget by remember { mutableStateOf<CcExecCommand?>(null) }
    var awaitingView by remember { mutableStateOf<CcViewSpec?>(null) }
    var confirmExec by remember { mutableStateOf<Pair<CcExecCommand, String?>?>(null) }
    var searchingSessions by remember { mutableStateOf(false) }
    var importingLink by remember { mutableStateOf(false) }
    var pendingLink by remember { mutableStateOf<String?>(null) }

    // `/cc provider del foo` typed in the chat box resolves here, once the server tables load
    LaunchedEffect(
        vm.ccRunRequested,
        vm.ccCatalogReady,
        vm.ccCatalogError,
        vm.ccStatus,
        vm.ccViews.size,
        vm.ccCommands.size,
    ) {
        val query = vm.ccRunRequested ?: return@LaunchedEffect
        if (!vm.ccCatalogReady) return@LaunchedEffect
        if (vm.ccCatalogError != null) {
            vm.clearCcRunRequest()
            vm.showToast("cc-switch 读取失败，请点右上角刷新后重试")
            return@LaunchedEffect
        }
        val status = vm.ccStatus
        if (status == null) {
            vm.clearCcRunRequest()
            vm.showToast("cc-switch 读取失败，请点右上角刷新后重试")
            return@LaunchedEffect
        }
        if (!status.available) {
            vm.clearCcRunRequest()
            vm.showToast("cc-switch 当前不可用，无法执行「$query」")
            return@LaunchedEffect
        }
        vm.clearCcRunRequest()
        when (val match = matchCcQuery(query, vm.ccViews, vm.ccCommands)) {
            // Words the server's tables do not name are still what Telegram runs: cc-switch
            // answers them itself, and the bot's guard decides whether a tap is needed first
            null -> vm.runCcRaw(query, false)
            is CcQuery.View -> {
                if (match.view.needsTarget && match.target == null) awaitingView = match.view
                else vm.ccShowView(match.view, match.target)
            }
            is CcQuery.Exec -> {
                val command = match.command
                when {
                    command.needsTarget && match.target == null -> awaitingTarget = command
                    command.confirm -> confirmExec = command to match.target
                    else -> vm.runCcExec(command.name, match.target, false)
                }
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "cc-switch 控制台",
            subtitle = "Provider、用量与会话配置",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新 cc-switch",
                    onClick = vm::refreshCc,
                )
            },
        )

        if (vm.ccBusy) {
            LoadingBar(modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 10.dp))
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            val status = vm.ccStatus
            if (status == null) {
                item {
                    EmptyState(
                        icon = Icons.Filled.Info,
                        title = if (vm.ccBusy) "正在读取 cc-switch" else "尚未加载 cc-switch",
                        message = if (vm.ccBusy) "正在读取 Provider 与命令列表。" else "点右上角刷新后重试。",
                    )
                }
            } else if (!status.available) {
                item { UnavailableCard(vm) }
            } else {
                item { StatusCard(vm, status) }
                if (status.error != null) {
                    item { OutputCard("读取 Provider 失败", status.error) }
                }
                item {
                    SectionHeader(
                        title = "Providers · ${status.providers.size}",
                        subtitle = "点 Provider 卡片中的「切换」应用到全局",
                        modifier = Modifier.padding(top = 8.dp),
                        action = {
                            AppIconButton(
                                icon = Icons.Filled.Add,
                                contentDescription = "新建 Provider",
                                onClick = {
                                    vm.ccProviderFormMeta()
                                    creatingProvider = true
                                },
                            )
                        },
                    )
                }
                if (status.providers.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Filled.Add,
                            title = "暂无 Provider",
                            message = "点上方 + 新建，或用 Deep Link 导入整套配置。",
                        )
                    }
                }
                items(status.providers, key = { it.id }) { provider ->
                    ProviderCard(
                        vm = vm,
                        provider = provider,
                        onUse = { confirmUse = provider },
                    )
                }
                item {
                    ActionsCard(
                        vm = vm,
                        onActivatePrompt = { activatingPrompt = true },
                        onImportMcp = { importingMcp = true },
                        onCreatePrompt = { creatingPrompt = true },
                        onSearchSessions = { searchingSessions = true },
                        onImportDeeplink = { importingLink = true },
                    )
                }
                item {
                    ViewsCard(
                        vm = vm,
                        onOpen = { view ->
                            if (view.needsTarget) awaitingView = view else vm.ccShowView(view)
                        },
                    )
                }
                vm.ccTestMessage?.let { message -> item { OutputCard("测速结果", message) } }
                if (vm.ccPanelText != null) {
                    item { PanelCard(vm) }
                }
                if (vm.ccCommands.isNotEmpty()) {
                    item {
                        ExecCard(
                            vm = vm,
                            commands = vm.ccCommands,
                            onStart = { command ->
                                when {
                                    command.needsTarget -> awaitingTarget = command
                                    command.confirm -> confirmExec = command to null
                                    else -> vm.runCcExec(command.name, null, false)
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    confirmUse?.let { provider ->
        AlertDialog(
            onDismissRequest = { confirmUse = null },
            title = { Text("切换 Provider", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    "将把 cc-switch 的全局配置切换到「${provider.name.ifBlank { provider.id }}」，影响 Bot 之后的所有调用。",
                    color = TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.ccUse(provider.id)
                    confirmUse = null
                }) { Text("切换") }
            },
            dismissButton = { TextButton(onClick = { confirmUse = null }) { Text("取消") } },
        )
    }

    if (activatingPrompt) {
        TextPromptDialog(
            title = "启用提示词",
            hint = "输入提示词 ID；可先点「提示词」查看列表。",
            confirmLabel = "启用",
            placeholder = "review",
            onDismiss = { activatingPrompt = false },
            onConfirm = { id ->
                vm.ccActivatePrompt(id.trim())
                activatingPrompt = false
            },
        )
    }

    if (importingMcp) {
        TextPromptDialog(
            title = "导入 MCP",
            hint = "粘贴 mcpServers 配置 JSON，导入后列表会自动刷新。",
            confirmLabel = "导入",
            placeholder = """{"mcpServers":{"fs":{"command":"npx","args":["-y","…"]}}}""",
            maxLines = 8,
            onDismiss = { importingMcp = false },
            onConfirm = { raw ->
                vm.ccImportMcp(raw)
                importingMcp = false
            },
        )
    }

    if (creatingProvider) {
        ProviderCreateDialog(
            meta = vm.ccProviderMeta,
            onDismiss = { creatingProvider = false },
            onCreate = { draft ->
                vm.ccAddProvider(draft)
                creatingProvider = false
            },
        )
    }

    if (creatingPrompt) {
        PromptCreateDialog(
            onDismiss = { creatingPrompt = false },
            onCreate = { name, content ->
                vm.ccCreatePrompt(name, content)
                creatingPrompt = false
            },
        )
    }

    if (searchingSessions) {
        TextPromptDialog(
            title = "搜索会话",
            hint = "关键词会交给 cc-switch 在会话索引里搜索（对应 /cc sessions search）。",
            confirmLabel = "搜索",
            placeholder = "例如：fix login",
            onDismiss = { searchingSessions = false },
            onConfirm = { value ->
                vm.ccSessionsSearch(value)
                searchingSessions = false
            },
        )
    }

    awaitingView?.let { view ->
        TextPromptDialog(
            title = view.label,
            hint = "输入${view.targetLabel}；不确定的话可先打开对应的列表视图。",
            confirmLabel = "查看",
            placeholder = view.targetLabel,
            maxLines = 2,
            onDismiss = { awaitingView = null },
            onConfirm = { value ->
                vm.ccShowView(view, value.trim())
                awaitingView = null
            },
        )
    }

    if (importingLink) {
        TextPromptDialog(
            title = "Deep Link 导入",
            hint = "粘贴 ccswitch://v1/import?... 链接；导入前会再让你确认一次。",
            confirmLabel = "下一步",
            placeholder = "ccswitch://v1/import?resource=mcp…",
            maxLines = 3,
            onDismiss = { importingLink = false },
            onConfirm = { value ->
                pendingLink = value.trim()
                importingLink = false
            },
        )
    }

    pendingLink?.let { link ->
        AlertDialog(
            onDismissRequest = { pendingLink = null },
            title = { Text("确认导入", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    "链接可能新增或覆盖 Provider、MCP、提示词等配置：\n" +
                        link.take(200) + if (link.length > 200) "…" else "",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.ccDeeplink(link)
                    pendingLink = null
                }) { Text("导入") }
            },
            dismissButton = { TextButton(onClick = { pendingLink = null }) { Text("取消") } },
        )
    }

    awaitingTarget?.let { command ->
        TextPromptDialog(
            title = command.label,
            hint = "输入${command.targetLabel}；可先用上方按钮查看列表。",
            confirmLabel = "继续",
            placeholder = command.targetLabel,
            onDismiss = { awaitingTarget = null },
            onConfirm = { value ->
                val target = value.trim()
                awaitingTarget = null
                if (target.isNotEmpty()) {
                    if (command.confirm) confirmExec = command to target
                    else vm.runCcExec(command.name, target, false)
                }
            },
        )
    }

    confirmExec?.let { (command, target) ->
        AlertDialog(
            onDismissRequest = { confirmExec = null },
            title = { Text("确认执行", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    buildString {
                        append("即将执行「${command.label}」")
                        if (target != null) append("，目标：$target")
                        append("。该操作会修改服务器上的 cc-switch 配置，且不可撤销。")
                    },
                    color = TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.runCcExec(command.name, target, true)
                    confirmExec = null
                }) { Text("确认执行") }
            },
            dismissButton = { TextButton(onClick = { confirmExec = null }) { Text("取消") } },
        )
    }

    // The bot's guard asks for this one; the words are exactly what cc-switch will receive
    vm.ccRawConfirmation?.let { words ->
        AlertDialog(
            onDismissRequest = vm::dismissCcRaw,
            title = { Text("确认执行", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    "即将执行「/cc $words」。\n" +
                        "cc-switch 认为这条命令会改动配置（删除、切换 Provider 或写全局设置），确认后才运行。",
                    color = TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = vm::confirmCcRaw) { Text("确认执行") }
            },
            dismissButton = { TextButton(onClick = vm::dismissCcRaw) { Text("取消") } },
        )
    }
}

/**
 * `/cc provider add`: cc-switch supplies the template and format choices, so
 * the form can only send values the CLI accepts (the server re-validates).
 */
@Composable
private fun ProviderCreateDialog(
    meta: CcProviderMeta?,
    onDismiss: () -> Unit,
    onCreate: (CcProviderDraft) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var id by remember { mutableStateOf("") }
    var template by remember { mutableStateOf<String?>(null) }
    var baseUrl by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var apiFormat by remember { mutableStateOf<String?>(null) }
    var config by remember { mutableStateOf("") }
    var pickingTemplate by remember { mutableStateOf(false) }
    var pickingFormat by remember { mutableStateOf(false) }
    // cc-switch decides which apps take base/key/model instead of raw JSON
    val fieldMode = meta?.fieldMode ?: true

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建 Provider", style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (fieldMode) {
                        "只需填写名称；API Key 仅随本次请求上传，服务器会抹掉后再返回结果。"
                    } else {
                        "当前应用（${meta?.app ?: "cc-switch"}）只接受原始 settings JSON：请填「配置」，密钥写在 JSON 里且不会回显。"
                    },
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                AppTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    placeholder = "名称（必填）",
                )
                AppTextField(
                    value = id,
                    onValueChange = { id = it },
                    singleLine = true,
                    placeholder = "ID（留空则自动生成）",
                )
                Row(horizontalArrangement = Arrangement.spacedBy(AppSpacing.sm)) {
                    SecondaryButton(
                        text = template ?: "模板 · 未选",
                        modifier = Modifier.weight(1f),
                        onClick = { pickingTemplate = true },
                    )
                    if (fieldMode) {
                        SecondaryButton(
                            text = apiFormat ?: "格式 · 未选",
                            modifier = Modifier.weight(1f),
                            onClick = { pickingFormat = true },
                        )
                    }
                }
                if (fieldMode) {
                    AppTextField(
                        value = baseUrl,
                        onValueChange = { baseUrl = it },
                        singleLine = true,
                        placeholder = "Base URL：https://…",
                    )
                    AppTextField(
                        value = apiKey,
                        onValueChange = { apiKey = it },
                        singleLine = true,
                        placeholder = "API Key",
                        visualTransformation = PasswordVisualTransformation(),
                    )
                    AppTextField(
                        value = model,
                        onValueChange = { model = it },
                        singleLine = true,
                        placeholder = "模型 ID，例如 claude-sonnet-4",
                    )
                }
                AppTextField(
                    value = config,
                    onValueChange = { config = it },
                    maxLines = 6,
                    placeholder = if (fieldMode) "可选：额外 settings JSON" else "settings JSON（必填）",
                    monospace = true,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onCreate(
                    CcProviderDraft(
                        name = name.trim(),
                        id = id.trim().takeIf { it.isNotEmpty() },
                        template = template,
                        baseUrl = if (fieldMode) baseUrl.trim().takeIf { it.isNotEmpty() } else null,
                        apiKey = if (fieldMode) apiKey.trim().takeIf { it.isNotEmpty() } else null,
                        model = if (fieldMode) model.trim().takeIf { it.isNotEmpty() } else null,
                        apiFormat = if (fieldMode) apiFormat else null,
                        config = config.trim().takeIf { it.isNotEmpty() },
                    ),
                )
            }, enabled = name.isNotBlank() && (fieldMode || config.isNotBlank())) { Text("创建") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )

    if (pickingTemplate) {
        OptionPickerDialog(
            title = "Provider 模板",
            options = meta?.templates.orEmpty(),
            selected = template,
            allowNone = true,
            onDismiss = { pickingTemplate = false },
            onSelect = { template = it },
        )
    }
    if (pickingFormat) {
        OptionPickerDialog(
            title = "API 格式",
            options = meta?.apiFormats.orEmpty(),
            selected = apiFormat,
            allowNone = true,
            onDismiss = { pickingFormat = false },
            onSelect = { apiFormat = it },
        )
    }
}

/** `/cc prompt new <name>` needs two fields, so it does not reuse TextPromptDialog. */
@Composable
private fun PromptCreateDialog(onDismiss: () -> Unit, onCreate: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var content by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建提示词", style = MaterialTheme.typography.titleLarge) },
        text = {
            Column {
                Text(
                    "名称只能用一个词（如 review），内容会写进 cc-switch 的提示词文件。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                AppTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.padding(top = 10.dp),
                    singleLine = true,
                    placeholder = "名称",
                )
                AppTextField(
                    value = content,
                    onValueChange = { content = it },
                    modifier = Modifier.padding(top = 10.dp),
                    maxLines = 8,
                    placeholder = "提示词内容",
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name.trim(), content) },
                enabled = name.isNotBlank() && !name.any { it.isWhitespace() } && content.isNotBlank(),
            ) { Text("创建") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(AppSpacing.md),
    ) {
        Text(
            label,
            color = TextTertiary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.weight(0.32f),
        )
        Text(
            value,
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.68f),
        )
    }
}

@Composable
private fun StatusCard(vm: AppViewModel, status: CcStatus) {
    AppCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("运行状态", style = MaterialTheme.typography.titleSmall)
                Text(
                    status.current ?: "未设置当前 Provider",
                    color = TextTertiary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            StatusPill(text = "可用", tone = StatusTone.Success)
        }
        Column(
            modifier = Modifier.padding(top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            InfoRow("应用", status.app)
            InfoRow("版本", status.version ?: "未知")
            InfoRow("二进制", status.bin ?: "—")
            InfoRow("当前 Provider", status.current ?: "未设置")
        }
        Row(
            modifier = Modifier.padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            QuietButton(
                text = "测速当前",
                icon = Icons.Filled.Speed,
                enabled = !vm.ccBusy,
                onClick = { vm.ccTest(null) },
            )
            QuietButton(
                text = "升级二进制",
                enabled = vm.opsActionBusy == null,
                onClick = { vm.runOpsAction("cc-update", "更新 cc-switch") },
            )
        }
    }
}

@Composable
private fun UnavailableCard(vm: AppViewModel) {
    AppCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("未检测到 cc-switch", style = MaterialTheme.typography.titleSmall)
                Text(
                    "可在服务器上一键安装，过程会执行 npm 并可能持续数分钟。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
            StatusPill(text = "未安装", tone = StatusTone.Warning)
        }
        PrimaryButton(
            text = "安装 cc-switch",
            modifier = Modifier.padding(top = 14.dp),
            icon = Icons.Filled.InstallDesktop,
            enabled = vm.opsActionBusy == null,
            onClick = { vm.runOpsAction("cc", "安装 cc-switch") },
        )
        if (vm.opsActionBusy != null) {
            Text(
                "正在执行：${vm.opsActionBusy}",
                color = TextTertiary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 7.dp),
            )
        }
    }
}

@Composable
private fun ProviderCard(vm: AppViewModel, provider: CcProvider, onUse: () -> Unit) {
    AppCard(contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    provider.name.ifBlank { provider.id },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    provider.id,
                    color = TextTertiary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            if (provider.current) {
                StatusPill(text = "使用中", tone = StatusTone.Success)
            } else {
                QuietButton(
                    text = "切换",
                    enabled = !vm.ccBusy,
                    onClick = onUse,
                )
            }
        }
        Row(
            modifier = Modifier.padding(top = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.xxs),
        ) {
            QuietButton(text = "测速", icon = Icons.Filled.Speed, enabled = !vm.ccBusy, onClick = { vm.ccTest(provider.id) })
            QuietButton(text = "流检", enabled = !vm.ccBusy, onClick = { vm.ccStream(provider.id) })
            QuietButton(text = "模型", enabled = !vm.ccBusy, onClick = { vm.ccProviderModels(provider.id) })
            QuietButton(text = "配额", enabled = !vm.ccBusy, onClick = { vm.ccQuota(provider.id) })
        }
    }
}

@Composable
private fun ActionsCard(
    vm: AppViewModel,
    onActivatePrompt: () -> Unit,
    onImportMcp: () -> Unit,
    onCreatePrompt: () -> Unit,
    onSearchSessions: () -> Unit,
    onImportDeeplink: () -> Unit,
) {
    AppCard {
        SectionHeader(title = "MCP / 提示词 / 环境", subtitle = "快捷管理操作")
        SectionLabel("MCP", modifier = Modifier.padding(top = 14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(AppSpacing.xs)) {
            QuietButton(text = "列表", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccShowPanel("mcp") })
            QuietButton(text = "同步", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccSyncMcp() })
            QuietButton(text = "导入", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = onImportMcp)
        }
        SectionLabel("提示词", modifier = Modifier.padding(top = 12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(AppSpacing.xs)) {
            QuietButton(text = "列表", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccShowPanel("prompts") })
            QuietButton(text = "启用", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = onActivatePrompt)
            QuietButton(text = "停用", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccDeactivatePrompt() })
            QuietButton(text = "新建", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = onCreatePrompt)
        }
        SectionLabel("环境", modifier = Modifier.padding(top = 12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(AppSpacing.xs)) {
            QuietButton(text = "检查", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccShowPanel("env-check") })
            QuietButton(text = "工具", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccShowPanel("env-tools") })
            QuietButton(text = "代理", modifier = Modifier.weight(1f), enabled = !vm.ccBusy, onClick = { vm.ccShowPanel("proxy") })
        }
        AppDivider(modifier = Modifier.padding(top = 6.dp), inset = 0.dp)
        SettingsRow(
            title = "搜索会话",
            subtitle = "按关键词查找 cc-switch 会话索引",
            onClick = if (!vm.ccBusy) onSearchSessions else null,
        )
        SettingsRow(
            title = "Deep Link 导入",
            subtitle = "导入整套 Provider / MCP / 提示词配置",
            onClick = if (!vm.ccBusy) onImportDeeplink else null,
        )
        SettingsRow(
            title = "全部命令",
            subtitle = "打开 cc-switch 命令参考",
            onClick = {
                vm.selectHelpSection("cc")
                vm.navigate(Screen.Help)
            },
        )
    }
}

/**
 * The read-only `/cc` views. The server sends this list (`GET /cc/views`), so a view
 * added on the bot side shows up here without an app release; views that need an
 * argument open a one-field dialog first.
 */
@Composable
private fun ViewsCard(vm: AppViewModel, onOpen: (CcViewSpec) -> Unit) {
    if (vm.ccViews.isEmpty()) return
    AppCard(contentPadding = PaddingValues(vertical = 6.dp)) {
        SectionHeader(
            title = "只读视图",
            subtitle = "结果在输出面板中展示",
            modifier = Modifier.padding(horizontal = AppSpacing.lg, vertical = 10.dp),
        )
        vm.ccViews.forEach { view ->
            SettingsRow(
                title = view.label,
                subtitle = if (view.needsTarget) "需要${view.targetLabel}" else null,
                onClick = if (!vm.ccBusy) {
                    { onOpen(view) }
                } else {
                    null
                },
            )
        }
        // Not one of the server's read-only views: the memory blobs are edited, not just printed
        AppDivider(inset = AppSpacing.lg)
        SettingsRow(
            title = "Hermes 记忆",
            subtitle = "编辑 MEMORY.md 与 USER.md",
            onClick = { vm.navigate(Screen.Hermes) },
        )
    }
}

/**
 * Danger zone: the mutating `/cc` commands the server allowlists. The list comes
 * from the API, so adding a command on the server shows up here without an app update.
 */
@Composable
private fun ExecCard(vm: AppViewModel, commands: List<CcExecCommand>, onStart: (CcExecCommand) -> Unit) {
    AppCard(contentPadding = PaddingValues(vertical = 6.dp)) {
        SectionHeader(
            title = "高级操作",
            subtitle = "会修改服务器配置，执行前需要确认",
            modifier = Modifier.padding(horizontal = AppSpacing.lg, vertical = 10.dp),
        )
        commands.groupBy { it.group }.forEach { (group, items) ->
            AppDivider(inset = AppSpacing.lg)
            SectionLabel(group, modifier = Modifier.padding(start = AppSpacing.lg, top = 14.dp, bottom = 2.dp))
            items.forEach { command ->
                SettingsRow(
                    title = command.label + if (command.needsTarget) " …" else "",
                    subtitle = if (command.needsTarget) "需要${command.targetLabel}" else null,
                    onClick = if (!vm.ccBusy) {
                        { onStart(command) }
                    } else {
                        null
                    },
                    trailing = if (command.confirm) {
                        { StatusPill(text = "需确认", tone = StatusTone.Warning) }
                    } else {
                        null
                    },
                )
            }
        }
    }
}

@Composable
private fun OutputCard(title: String, text: String) {
    AppCard {
        Text(title, style = MaterialTheme.typography.titleSmall)
        SelectionContainer {
            Text(
                text,
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.padding(top = 7.dp),
            )
        }
    }
}

@Composable
private fun PanelCard(vm: AppViewModel) {
    val title = vm.ccPanelTitle ?: return
    val text = vm.ccPanelText ?: return
    AppCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            QuietButton(text = "收起", onClick = vm::clearCcPanel)
        }
        SelectionContainer {
            Text(
                text.ifBlank { "（无输出）" },
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 7.dp)
                    .heightIn(max = 320.dp)
                    .verticalScroll(rememberScrollState()),
            )
        }
    }
}
