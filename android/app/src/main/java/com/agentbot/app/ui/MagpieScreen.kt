package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.MagpieSpec
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * Telegram's `/magpie` console: CLI/gateway status, the server-listed read-only views, and a
 * command box for everything else. Destructive commands come back from the server asking for
 * confirmation, so the same confirm dialog the chat uses appears here.
 */
@Composable
fun MagpieScreen(vm: AppViewModel) {
    var running by remember { mutableStateOf(false) }
    var targetFor by remember { mutableStateOf<MagpieSpec?>(null) }
    var commandTarget by remember { mutableStateOf<MagpieSpec?>(null) }
    val overview = vm.magpie

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "magpie 网关",
            subtitle = "模型网关状态与服务器命令",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.PlayArrow,
                    contentDescription = "执行 magpie 命令",
                    onClick = { running = true },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新 magpie 状态",
                    onClick = vm::refreshMagpie,
                )
            },
        )

        if (vm.magpieBusy) {
            LoadingBar(modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 10.dp))
        }
        vm.magpieError?.let { error ->
            InlineNotice(
                text = error,
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 6.dp),
                tone = MaterialTheme.colorScheme.error,
                icon = Icons.Filled.Error,
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            item {
                AppCard {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(AppSpacing.md),
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("magpie 网关", style = MaterialTheme.typography.titleSmall)
                            Text(
                                "CLI、网关地址与健康状态",
                                color = TextTertiary,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 2.dp),
                            )
                        }
                        if (overview == null && vm.magpieError != null) {
                            StatusPill(text = "读取失败", tone = StatusTone.Error)
                        } else if (overview?.available == true) {
                            StatusPill(
                                text = if (overview.healthy) "可达" else "不可达",
                                tone = if (overview.healthy) StatusTone.Success else StatusTone.Error,
                            )
                        } else {
                            StatusPill(text = "未安装", tone = StatusTone.Warning)
                        }
                    }

                    when {
                        overview == null -> {
                            InlineNotice(
                                text = if (vm.magpieBusy) "正在读取 magpie 状态…" else "尚未读取 magpie 状态。",
                                modifier = Modifier.padding(top = 12.dp),
                                icon = Icons.Filled.Info,
                            )
                            QuietButton(
                                text = "读取状态",
                                icon = Icons.Filled.Refresh,
                                onClick = vm::refreshMagpie,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                        !overview.available -> {
                            InlineNotice(
                                text = "magpie 未安装。可在服务器执行官方安装脚本，或设置 MAGPIE_BIN 后重启 Bot。",
                                modifier = Modifier.padding(top = 12.dp),
                                tone = MaterialTheme.colorScheme.error,
                                icon = Icons.Filled.Error,
                            )
                            Text(
                                "curl -fsSL https://usemagpie.ai/install.sh | sh",
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier.padding(top = 10.dp),
                            )
                        }
                        else -> {
                            Column(
                                modifier = Modifier.padding(top = 12.dp),
                                verticalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                MagpieInfoRow("版本", overview.version ?: "未知")
                                MagpieInfoRow("网关", overview.gatewayUrl.ifBlank { "—" })
                                overview.bin?.takeIf { it.isNotBlank() }?.let { MagpieInfoRow("二进制", it) }
                                overview.error?.takeIf { it.isNotBlank() }?.let {
                                    InlineNotice(
                                        text = it,
                                        modifier = Modifier.padding(top = 3.dp),
                                        tone = MaterialTheme.colorScheme.error,
                                        icon = Icons.Filled.Error,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            val views = overview?.views.orEmpty()
            if (overview?.available == true && views.isNotEmpty()) {
                item {
                    SectionHeader(
                        title = "只读视图",
                        subtitle = "结果会显示在下方输出卡片",
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                views.forEach { view ->
                    item(key = view.name) {
                        AppCard(contentPadding = PaddingValues(0.dp)) {
                            SettingsRow(
                                title = view.label,
                                subtitle = if (view.needsTarget) "需要${view.targetLabel}" else null,
                                onClick = {
                                    if (view.needsTarget) targetFor = view else vm.showMagpieView(view.name)
                                },
                            )
                        }
                    }
                }
            }

            val commands = overview?.commands.orEmpty()
            if (overview?.available == true && commands.isNotEmpty()) {
                item {
                    SectionHeader(
                        title = "可执行命令",
                        subtitle = "命令由服务器下发，危险操作会再次确认",
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                commands.forEach { command ->
                    item(key = "command-${command.name}") {
                        AppCard(contentPadding = PaddingValues(0.dp)) {
                            SettingsRow(
                                title = command.label,
                                subtitle = if (command.needsTarget) "需要${command.targetLabel}" else null,
                                onClick = if (!vm.magpieBusy) {
                                    {
                                        when {
                                            command.needsTarget -> commandTarget = command
                                            command.confirm -> vm.requestMagpieCommand(command)
                                            else -> vm.runMagpieCommand(command.name)
                                        }
                                    }
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

            vm.magpieOutput.takeIf { it.isNotBlank() }?.let { output ->
                item {
                    AppCard {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                vm.magpieTitle.ifBlank { "输出" },
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.weight(1f),
                            )
                            QuietButton(text = "收起", onClick = vm::clearMagpieOutput)
                        }
                        SelectionContainer {
                            Text(
                                output,
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 8.dp)
                                    .heightIn(max = 360.dp)
                                    .verticalScroll(rememberScrollState()),
                            )
                        }
                    }
                }
            }

            item {
                Text(
                    "提示：可直接输入 magpie 参数，例如 providers、quota、agent claude deepseek/deepseek-chat。" +
                        "需要桌面或交互的命令会被服务器拒绝。",
                    color = TextTertiary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }

    if (running) {
        TextPromptDialog(
            title = "执行 magpie 命令",
            hint = "与 Telegram 的 /magpie run 相同：逐词传给 magpie。破坏性命令会再弹一次确认。",
            confirmLabel = "执行",
            placeholder = "providers",
            onDismiss = { running = false },
            onConfirm = { input ->
                vm.runMagpie(input)
                running = false
            },
        )
    }

    targetFor?.let { view ->
        TextPromptDialog(
            title = view.label,
            hint = view.targetLabel,
            confirmLabel = "查看",
            placeholder = view.targetLabel,
            onDismiss = { targetFor = null },
            onConfirm = { input ->
                vm.showMagpieView(view.name, input.trim())
                targetFor = null
            },
        )
    }

    commandTarget?.let { command ->
        TextPromptDialog(
            title = command.label,
            hint = "输入${command.targetLabel}；服务器会再次校验目标。",
            confirmLabel = "继续",
            placeholder = command.targetLabel,
            onDismiss = { commandTarget = null },
            onConfirm = { value ->
                val target = value.trim()
                commandTarget = null
                if (target.isNotEmpty()) {
                    if (command.confirm) vm.requestMagpieCommand(command, target)
                    else vm.runMagpieCommand(command.name, target)
                }
            },
        )
    }

    vm.magpieConfirmation?.let { words ->
        AlertDialog(
            onDismissRequest = vm::dismissMagpieRun,
            confirmButton = {
                TextButton(onClick = vm::confirmMagpieRun) { Text("确认执行") }
            },
            dismissButton = {
                TextButton(onClick = vm::dismissMagpieRun) { Text("取消") }
            },
            title = { Text("需要确认", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    "服务器要求确认这条 magpie 命令：\n\n$words\n\n确认后会原样执行。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
        )
    }

    vm.magpieCommandConfirmation?.let { (command, target) ->
        AlertDialog(
            onDismissRequest = vm::dismissMagpieCommand,
            confirmButton = {
                TextButton(onClick = vm::confirmMagpieCommand) { Text("确认执行") }
            },
            dismissButton = {
                TextButton(onClick = vm::dismissMagpieCommand) { Text("取消") }
            },
            title = { Text("需要确认", style = MaterialTheme.typography.titleLarge) },
            text = {
                Text(
                    buildString {
                        append("即将执行「${command.label}」")
                        if (target != null) append("（$target）")
                        append("。\n\n这会修改服务器上的 magpie 配置或进程状态。")
                    },
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
        )
    }
}

@Composable
private fun MagpieInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(AppSpacing.md),
    ) {
        Text(
            label,
            color = TextTertiary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.weight(0.28f),
        )
        Text(
            value,
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.72f),
        )
    }
}
