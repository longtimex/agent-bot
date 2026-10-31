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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
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

/** Telegram's `/cc model` panel: custom OpenCode provider models and agent bindings. */
@Composable
fun ModelsScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }
    var assigning by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("模型管理", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("添加", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshCustomModels) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        Text(
            "自定义模型供 OpenCode 使用，添加后即可在切换模型的列表中选取；改动无需重启。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        if (vm.modelBusy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.customModels.isEmpty()) {
                item {
                    Text(
                        "暂无自定义模型。添加格式：简称 provider/modelID [显示名]。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            items(vm.customModels, key = { it.key }) { model ->
                CustomModelCard(vm, model) { pendingRemove = model.key }
            }
            if (vm.agentBindings.isNotEmpty()) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                            Text("Agent 绑定", style = MaterialTheme.typography.titleSmall)
                            vm.agentBindings.forEach { agent ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(modifier = Modifier.weight(1f).padding(top = 4.dp)) {
                                        Text(agent.name, style = MaterialTheme.typography.bodyMedium)
                                        Text(
                                            agent.model ?: "未设置",
                                            color = TextSecondary,
                                            style = MaterialTheme.typography.labelMedium,
                                        )
                                    }
                                    TextButton(
                                        onClick = { assigning = agent.name },
                                        enabled = !vm.modelBusy,
                                    ) { Text("设为模型") }
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
            hint = "格式：简称 provider/modelID [显示名]。例如：mymodel custom/my-model-id 我的模型。",
            confirmLabel = "添加",
            placeholder = "mymodel custom/my-model-id 我的模型",
            onDismiss = { adding = false },
            onConfirm = { input ->
                vm.addCustomModel(input)
                adding = false
            },
        )
    }

    assigning?.let { agent ->
        TextPromptDialog(
            title = "绑定 Agent 模型",
            hint = "为 $agent 指定模型：可用简称（sonnet、gpt-5）或 provider/modelID；绑定 self 会同时切换当前会话（上下文重置）。",
            confirmLabel = "绑定",
            placeholder = "sonnet",
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
            title = { Text("删除模型 $key？", style = MaterialTheme.typography.titleMedium) },
            text = {
                Text(
                    "删除后，指向该模型的会话会被重置为默认模型；仍被 agent 引用时会提示是否强制删除。",
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
            title = { Text("模型仍在使用中", style = MaterialTheme.typography.titleMedium) },
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
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(model.key, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Text(model.label, color = TextSecondary, style = MaterialTheme.typography.labelMedium)
            }
            Text(
                "${model.providerID}/${model.modelID}",
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
            model.desc?.takeIf { it.isNotBlank() && it != "自定义模型" }?.let {
                Text(it, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(enabled = !vm.modelBusy, onClick = onRemove) {
                    Text("🗑 删除", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}
