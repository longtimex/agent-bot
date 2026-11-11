package com.agentbot.app.ui

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.CustomModel
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's `/cc model` panel: custom OpenCode provider models and agent bindings. */
@Composable
fun ModelsScreen(vm: AppViewModel) {
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
        TextPromptDialog(
            title = "添加自定义模型",
            hint = "格式：简称 provider/modelID [显示名] [--attachment] [--context 200000] [--output 64000]。例如：mymodel custom/my-model-id 我的模型 --attachment。",
            confirmLabel = "添加",
            placeholder = "mymodel custom/my-model-id 我的模型 --attachment",
            error = vm.modelActionError.takeIf { vm.modelDraftRejected },
            onDismiss = { adding = false },
            onConfirm = { input ->
                if (vm.addCustomModel(input)) adding = false
            },
        )
    }

    assigning?.let { agent ->
        TextPromptDialog(
            title = "绑定 Agent 模型",
            hint = "为 $agent 指定模型：可用简称（sonnet、gpt-5）或 provider/modelID；绑定 self 会同时切换当前会话（上下文重置）。",
            confirmLabel = "绑定",
            placeholder = "sonnet",
            error = vm.modelActionError.takeIf { vm.modelDraftRejected },
            onDismiss = { assigning = null },
            onConfirm = { model ->
                vm.assignAgentModel(agent, model.trim())
                assigning = null
            },
        )
    }

    pendingRemove?.let { key ->
        AlertDialog(
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
        AlertDialog(
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
