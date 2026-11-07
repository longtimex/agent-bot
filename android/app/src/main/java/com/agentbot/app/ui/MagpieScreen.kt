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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.MagpieSpec
import com.agentbot.app.ui.theme.TextSecondary

/**
 * Telegram's `/magpie` console: CLI/gateway status, the server-listed read-only views, and a
 * command box for everything else. Destructive commands come back from the server asking for
 * confirmation, so the same confirm dialog the chat uses appears here.
 */
@Composable
fun MagpieScreen(vm: AppViewModel) {
    var running by remember { mutableStateOf(false) }
    var targetFor by remember { mutableStateOf<MagpieSpec?>(null) }
    val overview = vm.magpie

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("magpie 网关", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { running = true }) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("执行命令", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshMagpie) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        if (vm.magpieBusy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                        if (overview == null) {
                            Text("尚未加载。", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                        } else if (!overview.available) {
                            Text("magpie 未安装", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "在服务器执行：curl -fsSL https://usemagpie.ai/install.sh | sh，或设置 MAGPIE_BIN 后重启 Bot。",
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        } else {
                            Text(
                                "版本：${overview.version ?: "未知"}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                "网关：${overview.gatewayUrl} · ${if (overview.healthy) "✅ 可达" else "❌ 不可达"}",
                                color = if (overview.healthy) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                            overview.bin?.let {
                                Text("可执行文件：$it", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
                            }
                            overview.error?.takeIf { it.isNotBlank() }?.let {
                                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }

            val magpieViews = overview?.views.orEmpty()
            if (overview?.available == true && magpieViews.isNotEmpty()) {
                item {
                    Text("查看", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp))
                }
                magpieViews.forEach { view ->
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(view.label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                                TextButton(
                                    enabled = !vm.magpieBusy,
                                    onClick = {
                                        if (view.needsTarget) targetFor = view else vm.showMagpieView(view.name)
                                    },
                                ) { Text("查看") }
                            }
                        }
                    }
                }
            }

            vm.magpieOutput.takeIf { it.isNotBlank() }?.let { output ->
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    vm.magpieTitle.ifBlank { "输出" },
                                    style = MaterialTheme.typography.titleSmall,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = vm::clearMagpieOutput) { Text("关闭") }
                            }
                            SelectionContainer {
                                Text(
                                    output,
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }
                }
            }

            item {
                Text(
                    "提示：可直接输入 magpie 参数，例如 providers、quota、agent claude deepseek/deepseek-chat。" +
                        "需要桌面/交互的命令会被服务器拒绝。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 8.dp),
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

    vm.magpieConfirmation?.let { words ->
        AlertDialog(
            onDismissRequest = vm::dismissMagpieRun,
            confirmButton = {
                TextButton(onClick = vm::confirmMagpieRun) { Text("✅ 确认执行") }
            },
            dismissButton = {
                TextButton(onClick = vm::dismissMagpieRun) { Text("取消") }
            },
            title = { Text("需要确认", style = MaterialTheme.typography.titleMedium) },
            text = {
                Text(
                    "服务器要求确认这条 magpie 命令：\n\n$words\n\n确认后会原样执行。",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
        )
    }
}
