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
import androidx.compose.material3.Icon
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
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.AgentInfo
import com.agentbot.app.ui.theme.AppRadius
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

private data class PendingAgentAction(val agent: AgentInfo, val action: String)

/** Telegram's /agents panel: detect, install via npm/pip, update and uninstall managed CLIs. */
@Composable
fun AgentsScreen(vm: AppViewModel) {
    var pending by remember { mutableStateOf<PendingAgentAction?>(null) }
    val busy = vm.agentBusy != null

    // The request waits for the engine list, because the guards below read its flags
    LaunchedEffect(vm.agentConfirmRequested, vm.agents.size) {
        val request = vm.agentConfirmRequested ?: return@LaunchedEffect
        if (vm.agents.isEmpty()) {
            vm.refreshAgents()
            return@LaunchedEffect
        }
        vm.clearAgentConfirmRequest()
        val (engine, action) = request
        val agent = vm.agents.firstOrNull { it.id == engine || it.label.equals(engine, ignoreCase = true) }
        if (agent == null) {
            vm.showToast("未识别的 Agent CLI：$engine，可发送 /agents 查看可管理列表")
            return@LaunchedEffect
        }
        // The same refusals Telegram shows before it ever offers a confirm button
        val refusal = when {
            action == "install" && agent.installed -> "${agent.label} 已安装，无需重复安装"
            action == "install" && !agent.installable ->
                "${agent.label} 暂不支持自动安装${agent.install?.let { "，安装方式：$it" } ?: ""}"
            action != "install" && !agent.managed ->
                "${agent.label} 不是由 Bot 安装的，无法自动${if (action == "update") "更新" else "卸载"}"
            action == "uninstall" && agent.id == vm.session?.engine ->
                "当前正在使用 ${agent.label}，请先切换到其他引擎再卸载"
            else -> null
        }
        if (refusal != null) vm.showToast(refusal) else pending = PendingAgentAction(agent, action)
    }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "引擎管理",
            subtitle = "检测、安装与切换 Agent CLI",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新引擎列表",
                    onClick = vm::refreshAgents,
                )
            },
        )

        // Telegram's /agent panel names the current engine, so the management page does too
        Text(
            "当前引擎：${vm.session?.engineLabel ?: vm.session?.engine ?: "未知"}",
            color = TextTertiary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp),
        )

        if (busy) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                LoadingBar()
                Text(
                    "正在处理 ${vm.agentBusy}…（可能需要几分钟，期间可继续使用聊天）",
                    color = TextTertiary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }

        val result = vm.agentResult
        if (result != null) {
            AppCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
                contentPadding = PaddingValues(0.dp),
            ) {
                Row(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 12.dp), verticalAlignment = Alignment.Top) {
                    Column(modifier = Modifier.weight(1f)) {
                        StatusPill(
                            text = if (result.ok) "完成" else "失败",
                            tone = if (result.ok) StatusTone.Success else StatusTone.Error,
                        )
                        Text(
                            result.message ?: "操作结束",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(top = 7.dp),
                        )
                        result.output?.takeIf { it.isNotBlank() }?.let { output ->
                            Text(
                                output.takeLast(4_000),
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier
                                    .padding(top = 8.dp)
                                    .verticalScroll(rememberScrollState())
                                    .size(width = 320.dp, height = 120.dp),
                            )
                        }
                    }
                    AppIconButton(
                        icon = Icons.Filled.Close,
                        contentDescription = "关闭",
                        onClick = vm::clearAgentResult,
                    )
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(vm.agents, key = { it.id }) { agent ->
                val current = agent.id == vm.session?.engine
                AppCard(contentPadding = PaddingValues(0.dp)) {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                agent.label,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.weight(1f),
                            )
                            StatusPill(
                                text = when {
                                    current -> "当前"
                                    agent.installed && agent.managed -> "Bot 托管"
                                    agent.installed -> "已安装"
                                    else -> "未安装"
                                },
                                tone = when {
                                    current -> StatusTone.Success
                                    agent.installed -> StatusTone.Neutral
                                    else -> StatusTone.Warning
                                },
                            )
                        }
                        agent.desc?.let {
                            Text(
                                it,
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 5.dp),
                            )
                        }
                        // The two things Telegram explains after a switch: context and models
                        val capability = listOfNotNull(
                            agent.sessionMode?.let { if (agent.stateless) "每次全新会话" else "保留上下文" },
                            agent.supportsModel?.let { if (it) "可切换模型" else "模型由 CLI 配置" },
                        ).joinToString(" · ")
                        if (capability.isNotBlank()) {
                            Text(
                                capability,
                                color = TextTertiary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
                            )
                        }
                        if (agent.aliases.isNotEmpty()) {
                            Text(
                                "也可发送 /engine ${agent.id} 或 ${agent.aliases.take(3).joinToString("、")}",
                                color = TextTertiary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp),
                            )
                        }
                        agent.defaultModel?.let {
                            Text(
                                "默认模型：$it",
                                color = TextTertiary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp),
                            )
                        }
                        if (agent.install != null && !agent.installed && !agent.installable) {
                            Text(
                                "手动安装：${agent.install}",
                                color = TextTertiary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp),
                            )
                        }
                        AppDivider(modifier = Modifier.padding(top = 12.dp), inset = 16.dp)
                        Row(
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            // Every engine the bot can run is tappable here, as in Telegram's panel
                            if (!current) {
                                QuietButton(
                                    text = if (agent.installed) "使用" else "仍要使用",
                                    enabled = true,
                                    onClick = { vm.switchAgent(agent.id) },
                                )
                            }
                            if (agent.installable) {
                                QuietButton(
                                    text = "安装",
                                    enabled = !busy,
                                    onClick = { pending = PendingAgentAction(agent, "install") },
                                )
                            }
                            if (agent.updateable) {
                                QuietButton(
                                    text = "更新",
                                    enabled = !busy,
                                    onClick = { pending = PendingAgentAction(agent, "update") },
                                )
                            }
                            if (agent.uninstallable) {
                                QuietButton(
                                    text = "卸载",
                                    enabled = !busy,
                                    danger = true,
                                    onClick = { pending = PendingAgentAction(agent, "uninstall") },
                                )
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
            title = { Text("确认$verb ${request.agent.label}？", style = MaterialTheme.typography.titleLarge) },
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
