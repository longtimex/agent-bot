package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.agentbot.app.ui.theme.TextSecondary

/**
 * Telegram's `/cc` console. Read views plus typed write routes; the mutating
 * commands are listed by the server (`GET /cc/exec`), and free-form `/cc run`
 * arguments stay Telegram-only on purpose.
 */
@Composable
fun CcScreen(vm: AppViewModel) {
    var confirmUse by remember { mutableStateOf<CcProvider?>(null) }
    var activatingPrompt by remember { mutableStateOf(false) }
    var importingMcp by remember { mutableStateOf(false) }
    var creatingPrompt by remember { mutableStateOf(false) }
    var creatingProvider by remember { mutableStateOf(false) }
    var awaitingTarget by remember { mutableStateOf<CcExecCommand?>(null) }
    var confirmExec by remember { mutableStateOf<Pair<CcExecCommand, String?>?>(null) }
    var searchingSessions by remember { mutableStateOf(false) }
    var importingLink by remember { mutableStateOf(false) }
    var pendingLink by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("cc-switch 控制台", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = vm::refreshCc) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("刷新", modifier = Modifier.padding(start = 4.dp))
            }
        }

        if (vm.ccBusy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val status = vm.ccStatus
            if (status == null) {
                item {
                    Text(
                        if (vm.ccBusy) "正在读取 cc-switch…" else "暂无数据，点击刷新重试。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
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
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            "Providers（${status.providers.size}）",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        TextButton(onClick = {
                            vm.ccProviderFormMeta()
                            creatingProvider = true
                        }) { Text("＋ 新建") }
                    }
                }
                if (status.providers.isEmpty()) {
                    item {
                        Text(
                            "暂无 Provider：点「＋ 新建」添加，或用 Deep Link 导入整套配置。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodyMedium,
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
            title = { Text("切换 Provider", style = MaterialTheme.typography.titleMedium) },
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
            title = { Text("确认导入", style = MaterialTheme.typography.titleMedium) },
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
            title = { Text("确认执行", style = MaterialTheme.typography.titleMedium) },
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
        title = { Text("新建 Provider", style = MaterialTheme.typography.titleMedium) },
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
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("名称（必填）") },
                )
                OutlinedTextField(
                    value = id,
                    onValueChange = { id = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("ID（留空则自动生成）") },
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { pickingTemplate = true }, modifier = Modifier.weight(1f)) {
                        Text(template ?: "模板 · 未选", maxLines = 1)
                    }
                    if (fieldMode) {
                        OutlinedButton(onClick = { pickingFormat = true }, modifier = Modifier.weight(1f)) {
                            Text(apiFormat ?: "格式 · 未选", maxLines = 1)
                        }
                    }
                }
                if (fieldMode) {
                    OutlinedTextField(
                        value = baseUrl,
                        onValueChange = { baseUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text("Base URL：https://…") },
                    )
                    OutlinedTextField(
                        value = apiKey,
                        onValueChange = { apiKey = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        placeholder = { Text("API Key") },
                    )
                    OutlinedTextField(
                        value = model,
                        onValueChange = { model = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text("模型 ID，例如 claude-sonnet-4") },
                    )
                }
                OutlinedTextField(
                    value = config,
                    onValueChange = { config = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 6,
                    placeholder = { Text(if (fieldMode) "可选：额外 settings JSON" else "settings JSON（必填）") },
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
        title = { Text("新建提示词", style = MaterialTheme.typography.titleMedium) },
        text = {
            Column {
                Text(
                    "名称只能用一个词（如 review），内容会写进 cc-switch 的提示词文件。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    singleLine = true,
                    placeholder = { Text("名称") },
                )
                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    maxLines = 8,
                    placeholder = { Text("提示词内容") },
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
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            label,
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(end = 12.dp),
        )
        Text(value, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun StatusCard(vm: AppViewModel, status: CcStatus) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("状态", style = MaterialTheme.typography.titleSmall)
            InfoRow("应用", status.app)
            InfoRow("版本", status.version ?: "未知")
            InfoRow("二进制", status.bin ?: "—")
            InfoRow("当前 Provider", status.current ?: "未设置")
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccTest(null) }, enabled = !vm.ccBusy) { Text("⚡ 测速当前") }
                TextButton(onClick = { vm.runOpsAction("cc-update", "更新 cc-switch") }, enabled = vm.opsActionBusy == null) {
                    Text("升级二进制")
                }
            }
        }
    }
}

@Composable
private fun UnavailableCard(vm: AppViewModel) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("未检测到 cc-switch", style = MaterialTheme.typography.titleSmall)
            Text(
                "可在服务器上一键安装；安装过程会执行 npm 并可能持续数分钟，结果见运维中心。",
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(
                onClick = { vm.runOpsAction("cc", "安装 cc-switch") },
                enabled = vm.opsActionBusy == null,
            ) { Text("📦 安装 cc-switch") }
            if (vm.opsActionBusy != null) {
                Text("正在执行：${vm.opsActionBusy}", color = TextSecondary, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun ProviderCard(vm: AppViewModel, provider: CcProvider, onUse: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text(
                (if (provider.current) "✅ " else "") + (provider.name.ifBlank { provider.id }),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(provider.id, color = TextSecondary, style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onUse, enabled = !provider.current && !vm.ccBusy) {
                    Text(if (provider.current) "使用中" else "切换")
                }
                TextButton(onClick = { vm.ccTest(provider.id) }, enabled = !vm.ccBusy) { Text("⚡ 测速") }
                TextButton(onClick = { vm.ccStream(provider.id) }, enabled = !vm.ccBusy) { Text("📡 流检") }
                TextButton(onClick = { vm.ccProviderModels(provider.id) }, enabled = !vm.ccBusy) { Text("🧾 模型") }
                TextButton(onClick = { vm.ccQuota(provider.id) }, enabled = !vm.ccBusy) { Text("📊 配额") }
            }
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
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text("MCP / 提示词 / 环境", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("mcp") }, enabled = !vm.ccBusy) { Text("MCP 列表") }
                TextButton(onClick = { vm.ccSyncMcp() }, enabled = !vm.ccBusy) { Text("同步 MCP") }
                TextButton(onClick = onImportMcp, enabled = !vm.ccBusy) { Text("导入 MCP") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("prompts") }, enabled = !vm.ccBusy) { Text("提示词") }
                TextButton(onClick = onActivatePrompt, enabled = !vm.ccBusy) { Text("启用") }
                TextButton(onClick = { vm.ccDeactivatePrompt() }, enabled = !vm.ccBusy) { Text("停用") }
                TextButton(onClick = onCreatePrompt, enabled = !vm.ccBusy) { Text("新建") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("env-check") }, enabled = !vm.ccBusy) { Text("环境检查") }
                TextButton(onClick = { vm.ccShowPanel("env-tools") }, enabled = !vm.ccBusy) { Text("环境工具") }
                TextButton(onClick = { vm.ccShowPanel("proxy") }, enabled = !vm.ccBusy) { Text("代理") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("config") }, enabled = !vm.ccBusy) { Text("配置") }
                TextButton(onClick = { vm.ccShowPanel("sessions") }, enabled = !vm.ccBusy) { Text("会话") }
                TextButton(onClick = onSearchSessions, enabled = !vm.ccBusy) { Text("搜索会话") }
                TextButton(onClick = { vm.ccShowPanel("auth") }, enabled = !vm.ccBusy) { Text("认证") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onImportDeeplink, enabled = !vm.ccBusy) { Text("🔗 Deep Link 导入") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("skills") }, enabled = !vm.ccBusy) { Text("技能") }
                TextButton(onClick = { vm.ccShowPanel("failover") }, enabled = !vm.ccBusy) { Text("故障转移") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.ccShowPanel("daemon") }, enabled = !vm.ccBusy) { Text("守护进程") }
                TextButton(onClick = { vm.ccShowPanel("settings") }, enabled = !vm.ccBusy) { Text("设置") }
                // Same jump Telegram's「全部命令」makes: the shared cc-switch command reference
                TextButton(onClick = {
                    vm.selectHelpSection("cc")
                    vm.navigate(Screen.Help)
                }) { Text("全部命令") }
            }
        }
    }
}

/**
 * Danger zone: the mutating `/cc` commands the server allowlists. The list comes
 * from the API, so adding a command on the server shows up here without an app update.
 */
@Composable
private fun ExecCard(vm: AppViewModel, commands: List<CcExecCommand>, onStart: (CcExecCommand) -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("高级操作", style = MaterialTheme.typography.titleSmall)
            Text(
                "对应 Telegram 里需要按按钮确认的 /cc 命令，执行结果在上方面板查看。",
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
            commands.groupBy { it.group }.forEach { (group, items) ->
                Text(
                    group,
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
                items.forEach { command ->
                    TextButton(
                        onClick = { onStart(command) },
                        enabled = !vm.ccBusy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                command.label + if (command.needsTarget) " …" else "",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            if (command.confirm) {
                                Text("⚠️", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OutputCard(title: String, text: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            SelectionContainer {
                Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun PanelCard(vm: AppViewModel) {
    val title = vm.ccPanelTitle ?: return
    val text = vm.ccPanelText ?: return
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                TextButton(onClick = vm::clearCcPanel) { Text("收起") }
            }
            SelectionContainer {
                Text(
                    text.ifBlank { "（无输出）" },
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
        }
    }
}
