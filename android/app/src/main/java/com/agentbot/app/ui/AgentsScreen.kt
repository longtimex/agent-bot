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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.agentbot.app.data.AgentInfo
import com.agentbot.app.ui.theme.TextSecondary

private data class PendingAgentAction(val agent: AgentInfo, val action: String)

/** Telegram's /agents panel: detect, install via npm/pip, update and uninstall managed CLIs. */
@Composable
fun AgentsScreen(vm: AppViewModel) {
    var pending by remember { mutableStateOf<PendingAgentAction?>(null) }
    val busy = vm.agentBusy != null

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("引擎管理", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = vm::refreshAgents) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("刷新", modifier = Modifier.padding(start = 4.dp))
            }
        }

        if (busy) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                Text(
                    "正在处理 ${vm.agentBusy}…（可能需要几分钟，期间可继续使用聊天）",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }

        val result = vm.agentResult
        if (result != null) {
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (result.ok) {
                        MaterialTheme.colorScheme.surface
                    } else {
                        MaterialTheme.colorScheme.error.copy(alpha = 0.12f)
                    },
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
            ) {
                Row(modifier = Modifier.fillMaxWidth().padding(start = 14.dp, top = 10.dp), verticalAlignment = Alignment.Top) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            (if (result.ok) "✅ " else "❌ ") + (result.message ?: "操作结束"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        result.output?.takeIf { it.isNotBlank() }?.let { output ->
                            Text(
                                output.takeLast(4_000),
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier
                                    .padding(top = 6.dp)
                                    .verticalScroll(rememberScrollState())
                                    .size(width = 320.dp, height = 120.dp),
                            )
                        }
                    }
                    IconButton(onClick = vm::clearAgentResult, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.Close, contentDescription = "关闭", modifier = Modifier.size(16.dp))
                    }
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(vm.agents, key = { it.id }) { agent ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                agent.label,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                when {
                                    agent.installed && agent.managed -> "Bot 托管"
                                    agent.installed -> "已安装"
                                    else -> "未安装"
                                },
                                color = if (agent.installed) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    TextSecondary
                                },
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                        agent.desc?.let {
                            Text(it, color = TextSecondary, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                        }
                        agent.defaultModel?.let {
                            Text(
                                "默认模型：$it",
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.padding(top = 2.dp),
                            )
                        }
                        if (agent.install != null && !agent.installed && !agent.installable) {
                            Text(
                                "手动安装：${agent.install}",
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (agent.installable) {
                                TextButton(
                                    enabled = !busy,
                                    onClick = { pending = PendingAgentAction(agent, "install") },
                                ) { Text("⬇️ 安装") }
                            }
                            if (agent.updateable) {
                                TextButton(
                                    enabled = !busy,
                                    onClick = { pending = PendingAgentAction(agent, "update") },
                                ) { Text("🔄 更新") }
                            }
                            if (agent.uninstallable) {
                                TextButton(
                                    enabled = !busy,
                                    onClick = { pending = PendingAgentAction(agent, "uninstall") },
                                ) { Text("🗑 卸载", color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            }
        }
    }

    pending?.let { request ->
        val verb = when (request.action) {
            "install" -> "安装"
            "update" -> "更新"
            else -> "卸载"
        }
        val command = when (request.action) {
            "install" -> request.agent.installCommand
            "update" -> request.agent.updateCommand
            else -> request.agent.uninstallCommand
        }
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("确认$verb ${request.agent.label}？", style = MaterialTheme.typography.titleMedium) },
            text = {
                Column {
                    Text(
                        command?.let { "将执行：$it" } ?: "将执行 Bot 托管的安装命令。",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        when (request.action) {
                            "install" -> "仅支持内置的 npm/pip 安装方式，完成后即可切换使用。"
                            "update" -> "会覆盖 Bot 托管的版本。"
                            else -> "只会移除由 Bot 安装的版本。"
                        },
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.runAgentAction(request.agent.id, request.action)
                    pending = null
                }) { Text("确认$verb") }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }) { Text("取消") }
            },
        )
    }
}
