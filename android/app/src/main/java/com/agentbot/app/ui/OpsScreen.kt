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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
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
import com.agentbot.app.data.Diagnostics
import com.agentbot.app.data.OpsResult
import com.agentbot.app.ui.theme.TextSecondary

private val LOG_LINE_CHOICES = listOf(80, 200, 400)

/** Telegram's /ops panel: runtime diagnostics plus bot/opencode log tails. */
@Composable
fun OpsScreen(vm: AppViewModel) {
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    val busyLabel = vm.opsActionBusy

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("运维中心", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = {
                vm.refreshDiagnostics()
                vm.refreshLogs()
                vm.refreshOpsService()
            }) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("刷新", modifier = Modifier.padding(start = 4.dp))
            }
        }

        if (vm.opsBusy || busyLabel != null) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                busyLabel?.let {
                    Text(
                        "正在$it…（更新与构建可能需要数分钟，期间 Bot 仍可聊天）",
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { OpsActionsCard(vm) { path, label -> pending = path to label } }
            vm.serviceStatus?.let { status -> item { ServiceCard(vm, status.reachable, status.managed, status.pid, status.url) { path, label -> pending = path to label } } }
            vm.opsResult?.let { result -> item { OpsResultCard(result, vm::clearOpsResult) } }
            val diag = vm.diagnostics
            if (diag != null) {
                item { DiagnosticsCard(diag) }
            } else if (!vm.opsBusy) {
                item {
                    Text(
                        "暂无诊断数据，点击刷新重试。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            item { LogCard(vm) }
        }
    }

    pending?.let { (path, label) ->
        val (body, confirm) = when (path) {
            "update" -> "将执行 git pull --ff-only、npm install 与 npm run build；工作区有未提交改动时会中止。" to "更新"
            "restart" -> "将重启 Bot 进程，连接会短暂中断；重启完成后会自动恢复。" to "重启"
            "service/stop" -> "只会停止由 Bot 启动的 OpenCode（通过 data/opencode.pid 识别）。" to "停止"
            "service/restart" -> "将重启由 Bot 托管的 OpenCode 服务。" to "重启"
            else -> "确定执行该操作？" to "执行"
        }
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("$label？", style = MaterialTheme.typography.titleMedium) },
            text = { Text(body, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    vm.runOpsAction(path, label)
                    pending = null
                }) { Text(confirm) }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun OpsActionsCard(vm: AppViewModel, onConfirm: (String, String) -> Unit) {
    val busy = vm.opsActionBusy != null
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text("项目维护", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(enabled = !busy, onClick = { vm.runOpsAction("check", "运行检查") }) { Text("🧪 运行检查") }
                TextButton(enabled = !busy, onClick = { onConfirm("update", "更新项目") }) { Text("⬆️ 更新项目") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(enabled = !busy, onClick = { onConfirm("restart", "重启 Bot") }) {
                    Text("🔄 重启 Bot", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun ServiceCard(
    vm: AppViewModel,
    reachable: Boolean,
    managed: Boolean,
    pid: Int?,
    url: String?,
    onConfirm: (String, String) -> Unit,
) {
    val busy = vm.opsActionBusy != null
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("⚡ OpenCode 服务", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(
                    if (reachable) "🟢 运行中" else "🔴 未运行",
                    color = if (reachable) MaterialTheme.colorScheme.primary else TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            InfoRow("地址", url ?: "—")
            InfoRow("托管", if (managed && pid != null) "Bot 托管（PID $pid）" else if (reachable) "运行中，未托管" else "未运行")
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (!reachable) {
                    TextButton(enabled = !busy, onClick = { vm.runOpsAction("service/start", "启动 OpenCode") }) { Text("▶️ 启动") }
                }
                TextButton(enabled = !busy, onClick = { onConfirm("service/restart", "重启 OpenCode") }) { Text("🔄 重启") }
                TextButton(enabled = !busy, onClick = { onConfirm("service/stop", "停止 OpenCode") }) {
                    Text("⏹ 停止", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun OpsResultCard(result: OpsResult, onClose: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (result.ok) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.error.copy(alpha = 0.12f),
        ),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    (if (result.ok) "✅ " else "❌ ") + (result.message ?: "操作结束"),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onClose) { Text("关闭") }
            }
            result.steps.filter { it.output.isNotBlank() }.forEach { step ->
                Text(
                    "${if (step.ok) "✓" else "✗"} ${step.label}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 6.dp),
                )
                SelectionContainer {
                    Text(
                        step.output.takeLast(4_000),
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 180.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}

@Composable
private fun DiagnosticsCard(diag: Diagnostics) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            InfoRow("Node", diag.node ?: "—")
            InfoRow("平台", diag.platform ?: "—")
            InfoRow("PID", diag.pid?.toString() ?: "—")
            InfoRow("运行时长", formatUptime(diag.uptimeSec))
            InfoRow("服务管理", if (diag.systemd == true) "systemd" else "进程模式")
            InfoRow("项目目录", diag.projectDir ?: "—")
            diag.git?.let { git ->
                InfoRow(
                    "Git",
                    buildString {
                        append(git.branch ?: "—")
                        git.commit?.take(7)?.let { append(" @ ").append(it) }
                        if (git.dirty == true) append("（有未提交改动）")
                    },
                )
            }
            diag.opencode?.let { oc ->
                InfoRow(
                    "OpenCode",
                    buildString {
                        append(oc.url ?: "—")
                        append(if (oc.reachable == true) " · 可达" else " · 不可达")
                        if (oc.managed == true && oc.pid != null) append(" · Bot 托管 PID ").append(oc.pid)
                    },
                )
            }
            InfoRow(
                "cc-switch",
                diag.ccSwitch?.let { "${it.bin}${it.version?.let { v -> " $v" } ?: ""}" } ?: "未安装",
            )
            diag.disk?.let { disk ->
                InfoRow("磁盘", "${formatBytes(disk.freeBytes)} 可用 / ${formatBytes(disk.totalBytes)}")
            }
            diag.memory.let { mem ->
                InfoRow("内存", "${formatBytes(mem.freeBytes)} 可用 / ${formatBytes(mem.totalBytes)}")
            }
            val log = diag.log
            if (log != null) InfoRow("Bot 日志", "${formatBytes(log.bytes)} · ${log.path ?: "—"}")
            diag.opencodeLog?.let { InfoRow("OpenCode 日志", "${formatBytes(it.bytes)} · ${it.path ?: "—"}") }
        }
    }
}

@Composable
private fun LogCard(vm: AppViewModel) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text("日志", style = MaterialTheme.typography.titleSmall)
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FilterChip(
                    selected = vm.logSource == "bot",
                    onClick = { vm.refreshLogs("bot", vm.logLines) },
                    label = { Text("Bot") },
                )
                FilterChip(
                    selected = vm.logSource == "opencode",
                    onClick = { vm.refreshLogs("opencode", vm.logLines) },
                    label = { Text("OpenCode") },
                )
                LOG_LINE_CHOICES.forEach { count ->
                    FilterChip(
                        selected = vm.logLines == count,
                        onClick = { vm.refreshLogs(vm.logSource, count) },
                        label = { Text("$count 行") },
                    )
                }
            }

            val tail = vm.logTail
            val text = when {
                tail == null -> "（尚未加载）"
                tail.missing -> "日志尚未生成：${tail.path ?: ""}"
                !tail.ok -> "读取日志失败"
                tail.text.isBlank() -> "（日志为空）"
                else -> tail.text
            }
            SelectionContainer {
                Text(
                    text,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (tail != null && tail.ok && !tail.missing) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        TextSecondary
                    },
                    modifier = Modifier
                        .padding(top = 10.dp)
                        .fillMaxWidth()
                        .heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
            if (tail != null && tail.ok && !tail.missing) {
                Text(
                    "显示最近 ${vm.logLines} 行 · ${formatBytes(tail.bytes)}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            label,
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.width(96.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1_024 -> "%.1f KB".format(bytes / 1_024.0)
    else -> "$bytes B"
}

private fun formatUptime(seconds: Long): String = when {
    seconds >= 86_400 -> "${seconds / 86_400} 天 ${(seconds % 86_400) / 3_600} 小时"
    seconds >= 3_600 -> "${seconds / 3_600} 小时 ${(seconds % 3_600) / 60} 分钟"
    seconds >= 60 -> "${seconds / 60} 分钟"
    else -> "${seconds} 秒"
}
