package com.agentbot.app.ui

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.CustomModel
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's `/cc model` panel: custom OpenCode provider models and agent bindings. */
@Composable
fun ModelsScreen(vm: AppViewModel) {
    // OpenCode keeps its provider registry; every other engine gets a plain id list
    if (vm.agentModelEngine != "opencode") {
        AgentEngineModelsScreen(vm)
        return
    }
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }
    var assigning by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "模型管理",
            subtitle = "为 OpenCode 添加与绑定自定义模型",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "添加模型",
                    onClick = { adding = true },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新模型",
                    onClick = vm::refreshCustomModels,
                )
            }
        )

        Text(
            "自定义模型供 OpenCode 使用，添加后即可在切换模型的列表中选取；改动无需重启。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        EngineModelChips(vm)

        if (vm.modelBusy || vm.customModelsBusy) {
            LoadingBar(modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        }

        PageErrorNotice(
            message = vm.modelActionError,
            onDismiss = { vm.modelActionError = null },
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val loadError = vm.customModelsError
            if (loadError != null) {
                item {
                    PageLoadError(
                        title = "暂时无法加载模型",
                        message = loadError,
                        icon = Icons.Filled.Memory,
                        modifier = Modifier.fillParentMaxSize(),
                        onRetry = vm::refreshCustomModels,
                    )
                }
            } else if (vm.customModelsBusy && vm.customModels.isEmpty()) {
                item {
                    Text(
                        "正在读取自定义模型…",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else if (vm.customModels.isEmpty()) {
                item {
                    AppCard {
                        Text("还没有自定义模型", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "点右上角 + 添加。格式：简称 provider/modelID [显示名]。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = 5.dp),
                        )
                    }
                }
            }
            if (loadError == null) {
                items(vm.customModels, key = { it.key }) { model ->
                    CustomModelCard(vm, model) { pendingRemove = model.key }
                }
            }
            if (loadError == null && vm.agentBindings.isNotEmpty()) {
                item {
                    AppCard(contentPadding = PaddingValues(0.dp)) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text(
                                "Agent 绑定",
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 2.dp),
                            )
                            vm.agentBindings.forEach { agent ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(modifier = Modifier.weight(1f).padding(top = 4.dp)) {
                                        Text(agent.name, style = MaterialTheme.typography.bodyMedium)
                                        Text(
                                            agent.model ?: "未设置",
                                            color = TextSecondary,
                                            style = MaterialTheme.typography.labelSmall,
                                        )
                                    }
                                    QuietButton(
                                        text = "设为模型",
                                        onClick = { assigning = agent.name },
                                        enabled = !vm.modelBusy,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        CustomModelDialog(vm) { adding = false }
    }

    assigning?.let { agent ->
        TextPromptDialog(
            title = "绑定 Agent 模型",
            hint = "为 $agent 指定模型：可用已登记的简称，或 provider/modelID；绑定 self 会同时切换当前会话（上下文重置）。",
            confirmLabel = "绑定",
            placeholder = "provider/modelID 或简称",
            error = vm.modelActionError.takeIf { vm.modelDraftRejected },
            onDismiss = { assigning = null },
            onConfirm = { model ->
                vm.assignAgentModel(agent, model.trim())
                assigning = null
            },
        )
    }

    pendingRemove?.let { key ->
        AppDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("删除模型 $key？", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    "删除后，指向该模型的会话会清除模型选择，之后由引擎自身配置决定；仍被 agent 引用时会提示是否强制删除。",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.removeCustomModel(key)
                    pendingRemove = null
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemove = null }) { Text("取消") }
            },
        )
    }

    vm.modelDeleteBlocked?.let { message ->
        val key = vm.modelDeleteBlockedKey
        AppDialog(
            onDismissRequest = vm::clearModelDeleteBlocked,
            title = { Text("模型仍在使用中", style = MaterialTheme.typography.titleLarge) },
            text = { Text(message, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    vm.clearModelDeleteBlocked()
                    if (key != null) vm.removeCustomModel(key, force = true)
                }) { Text("强制删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = vm::clearModelDeleteBlocked) { Text("取消") }
            },
        )
    }
}

@Composable
private fun CustomModelCard(vm: AppViewModel, model: CustomModel, onRemove: () -> Unit) {
    AppCard(contentPadding = PaddingValues(0.dp)) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(model.key, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(model.label, color = TextSecondary, style = MaterialTheme.typography.labelMedium)
            }
            Text(
                "${model.providerID}/${model.modelID}",
                color = TextTertiary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 3.dp),
            )
            model.desc?.takeIf { it.isNotBlank() && it != "自定义模型" }?.let {
                Text(
                    it,
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp),
                )
            }
            Row(
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                QuietButton(
                    text = "删除",
                    enabled = !vm.modelBusy,
                    danger = true,
                    onClick = onRemove,
                )
            }
        }
    }
}

/** Engines whose model list this screen can edit; OpenCode is first because it is the default. */
@Composable
private fun EngineModelChips(vm: AppViewModel) {
    val engines = (listOf("opencode") + vm.agents.filter { it.supportsModel == true }.map { it.id }).distinct()
    LazyRow(
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(engines, key = { it }) { engine ->
            val label = vm.agents.firstOrNull { it.id == engine }?.label ?: "OpenCode"
            val selected = vm.agentModelEngine == engine
            Surface(
                shape = RoundedCornerShape(50),
                color = if (selected) {
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                modifier = Modifier.clickable { vm.selectAgentModelEngine(engine) },
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (selected) MaterialTheme.colorScheme.primary else TextSecondary,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/**
 * Custom model ids for one CLI engine. A CLI takes the name as a plain `--model`, so an id the
 * bot's built-in table does not know yet still works once it is listed here.
 */
@Composable
private fun AgentEngineModelsScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }
    val engine = vm.agentModelEngine
    val label = vm.agents.firstOrNull { it.id == engine }?.label ?: engine

    LaunchedEffect(engine) { vm.loadAgentCustomModels(engine) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "模型管理",
            subtitle = "$label 的自定义模型",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "添加模型",
                    onClick = { adding = true },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新模型",
                    onClick = { vm.loadAgentCustomModels(engine) },
                )
            },
        )
        EngineModelChips(vm)
        Text(
            "把 $label 新出的模型 ID 加进来，切换模型时就能直接选。CLI 自己报告的模型优先，同名的自定义项会被忽略。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        PageErrorNotice(
            message = vm.agentModelError,
            onDismiss = { vm.agentModelError = null },
        )
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (vm.agentCustomModels.isEmpty()) {
                item {
                    AppCard {
                        Text("还没有自定义模型", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "点右上角 + 添加，格式：模型 ID [显示名]，例如 claude-opus-4-6 Opus 4.6。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = 5.dp),
                        )
                    }
                }
            }
            items(vm.agentCustomModels, key = { it.value }) { model ->
                AppCard {
                    Text(model.label, style = MaterialTheme.typography.titleSmall)
                    Text(
                        model.value,
                        color = TextTertiary,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 3.dp),
                    )
                    Row(modifier = Modifier.padding(top = 6.dp)) {
                        QuietButton(
                            text = "删除",
                            danger = true,
                            onClick = { pendingRemove = model.value },
                        )
                    }
                }
            }
        }
    }

    if (adding) {
        TextPromptDialog(
            title = "添加自定义模型",
            hint = "格式：模型 ID [显示名]。显示名可省略，省略时列表里显示 ID。",
            confirmLabel = "添加",
            placeholder = "claude-opus-4-6 Opus 4.6",
            onDismiss = { adding = false },
            onConfirm = { input ->
                val trimmed = input.trim()
                if (trimmed.isNotEmpty()) {
                    val space = trimmed.indexOf(' ')
                    val value = if (space > 0) trimmed.substring(0, space) else trimmed
                    val name = if (space > 0) trimmed.substring(space + 1).trim() else ""
                    vm.addAgentCustomModel(value, name)
                    adding = false
                }
            },
        )
    }

    pendingRemove?.let { value ->
        AppDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("删除 $value？", style = MaterialTheme.typography.titleLarge) },
            text = { Text("删除后切换模型的列表里不再出现它。", style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    vm.removeAgentCustomModel(value)
                    pendingRemove = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemove = null }) { Text("取消") }
            },
        )
    }
}

/**
 * The full provider form: an id pair, plus the endpoint and key when the provider does not exist
 * yet, plus a probe so a wrong baseURL fails here instead of inside a conversation.
 */
@Composable
private fun CustomModelDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    var providerID by remember { mutableStateOf("") }
    var modelID by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var baseURL by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { vm.resetModelTest() }
    val testing = vm.modelTesting
    val result = vm.modelTestResult

    AppDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加自定义模型", style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "填 Provider 与模型 ID。要新建 Provider，再填 baseURL 与 API Key（Key 会明文写入 opencode.json）。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                AppTextField(
                    value = providerID,
                    onValueChange = { providerID = it },
                    placeholder = "Provider ID（如 openrouter）",
                    singleLine = true,
                )
                AppTextField(
                    value = modelID,
                    onValueChange = {
                        modelID = it
                        if (key.isBlank()) key = it.substringAfterLast('/').lowercase()
                    },
                    placeholder = "模型 ID（如 gpt-4o）",
                    singleLine = true,
                )
                AppTextField(
                    value = key,
                    onValueChange = { key = it },
                    placeholder = "简称（默认取模型 ID 末段）",
                    singleLine = true,
                )
                AppTextField(
                    value = label,
                    onValueChange = { label = it },
                    placeholder = "显示名（可选）",
                    singleLine = true,
                )
                AppTextField(
                    value = baseURL,
                    onValueChange = { baseURL = it },
                    placeholder = "baseURL（留空 = Provider 已存在）",
                    singleLine = true,
                )
                AppTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    placeholder = "API Key（可选）",
                    singleLine = true,
                )
                result?.let {
                    Text(
                        it.message,
                        color = if (it.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        },
        confirmButton = {
            Row {
                TextButton(
                    onClick = { vm.testModelConnection(baseURL, apiKey, modelID) },
                    enabled = baseURL.isNotBlank() && !testing,
                ) { Text(if (testing) "测试中…" else "测试连通") }
                TextButton(
                    onClick = { vm.addCustomModelFull(key, providerID, modelID, label, baseURL, apiKey) },
                    enabled = providerID.isNotBlank() && modelID.isNotBlank() && !testing,
                ) { Text("添加") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
