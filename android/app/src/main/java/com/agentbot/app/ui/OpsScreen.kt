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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ApiFormat
import com.agentbot.app.data.Diagnostics
import com.agentbot.app.data.OpsResult
import com.agentbot.app.data.StartupCheck
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

private val LOG_LINE_CHOICES = listOf(80, 200, 400)

/** Telegram's /ops panel: runtime diagnostics plus bot/opencode log tails. */
@Composable
fun OpsScreen(vm: AppViewModel) {
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    val busyLabel = vm.opsActionBusy

    // `/restart`, `/update` and `/service opencode stop` typed in the chat box land here
    LaunchedEffect(vm.opsConfirmRequested) {
        vm.opsConfirmRequested?.let {
            vm.clearOpsConfirmRequest()
            pending = it
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "运维中心",
            subtitle = "诊断、日志、服务与发布管理",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新运维数据",
                    onClick = {
                        vm.refreshDiagnostics()
                        vm.refreshLogs()
                        vm.refreshOpsService()
                    },
                )
            },
        )

        if (vm.opsBusy || busyLabel != null) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                LoadingBar()
                busyLabel?.let {
                    Text(
                        "正在$it…（更新与构建可能需要数分钟，期间 Bot 仍可聊天）",
                        color = TextTertiary,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item { OpsActionsCard(vm) { path, label -> pending = path to label } }
            vm.serviceStatus?.let { status -> item { ServiceCard(vm, status.reachable, status.managed, status.pid, status.url) { path, label -> pending = path to label } } }
            vm.opsResult?.let { result -> item { OpsResultCard(result, vm::clearOpsResult) } }
            item { ReleaseCard(vm) { path, label -> pending = path to label } }
            val diag = vm.diagnostics
            if (diag != null) {
                item { DiagnosticsCard(diag) }
            } else if (!vm.opsBusy) {
                item {
                    Text(
                        "暂无诊断数据，点击刷新重试。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
            }
            item { LogCard(vm) }
            vm.startupCheck?.let { check -> item { StartupCard(check) } }
        }
    }

    pending?.let { (path, label) ->
        val (body, confirm) = when (path) {
            "update" -> "将在独立目录克隆当前分支、安装依赖并运行发布门禁；不会改动正在运行的 checkout。完成后还需重启 Bot 应用。" to "更新"
            "restart" -> if (vm.releaseInfo?.pending != null) {
                "将激活预构建版本并重启 Bot。连接会短暂中断；新版本健康检查失败会自动回滚。" to "应用并重启"
            } else {
                "将重启 Bot 进程，连接会短暂中断；重启完成后会自动恢复。" to "重启"
            }
            "cancel-pending" -> "将丢弃等待应用的预构建版本；当前运行的版本不受影响。" to "丢弃"
            "rollback" -> "将把当前 release 指针切到上一版。还需重启 Bot 使其生效，原版本会保留以便再次回滚。" to "回滚"
            "service/stop" -> "只会停止由 Bot 启动的 OpenCode（通过 data/opencode.pid 识别）。" to "停止"
            "service/restart" -> "将重启由 Bot 托管的 OpenCode 服务。" to "重启"
            else -> "确定执行该操作？" to "执行"
        }
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("$label？", style = MaterialTheme.typography.titleLarge) },
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
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeader(title = "项目维护")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(
                    text = "运行检查",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    onClick = { vm.runOpsAction("check", "运行检查") },
                )
                SecondaryButton(
                    text = "检查更新",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    onClick = { vm.checkForUpdates() },
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(
                    text = "更新项目",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    onClick = { onConfirm("update", "更新项目") },
                )
                SecondaryButton(
                    text = "备份数据",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    onClick = { vm.shareBackup() },
                )
            }
            SecondaryButton(
                text = "重启 Bot",
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
                danger = true,
                onClick = { onConfirm("restart", "重启 Bot") },
            )
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
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("OpenCode 服务", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                StatusPill(
                    text = if (reachable) "运行中" else "未运行",
                    tone = if (reachable) StatusTone.Success else StatusTone.Warning,
                )
            }
            InfoRow("地址", url ?: "—")
            InfoRow("托管", if (managed && pid != null) "Bot 托管（PID $pid）" else if (reachable) "运行中，未托管" else "未运行")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!reachable) {
                    SecondaryButton(
                        text = "启动",
                        modifier = Modifier.weight(1f),
                        enabled = !busy,
                        onClick = { vm.runOpsAction("service/start", "启动 OpenCode") },
                    )
                }
                SecondaryButton(
                    text = "重启",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    onClick = { onConfirm("service/restart", "重启 OpenCode") },
                )
                SecondaryButton(
                    text = "停止",
                    modifier = Modifier.weight(1f),
                    enabled = !busy,
                    danger = true,
                    onClick = { onConfirm("service/stop", "停止 OpenCode") },
                )
            }
        }
    }
}

@Composable
private fun OpsResultCard(result: OpsResult, onClose: () -> Unit) {
    AppCard {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill(
                    text = if (result.ok) "完成" else "失败",
                    tone = if (result.ok) StatusTone.Success else StatusTone.Error,
                )
                Spacer(modifier = Modifier.width(10.dp))
                Text(result.message ?: "操作结束", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                QuietButton(text = "关闭", onClick = onClose)
            }
            result.steps.filter { it.output.isNotBlank() }.forEach { step ->
                Text(
                    step.label,
                    color = if (step.ok) TextSecondary else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 10.dp),
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
private fun ReleaseCard(vm: AppViewModel, onConfirm: (String, String) -> Unit) {
    val release = vm.releaseInfo
    val update = vm.diagnostics?.update ?: null
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("版本与更新", style = MaterialTheme.typography.titleSmall)
            InfoRow("当前 release", release?.label?.takeIf { it.isNotBlank() } ?: "checkout")
            release?.current?.let { InfoRow("Current ID", it) }
            release?.pending?.let { InfoRow("Pending", it) }
            release?.previous?.let { InfoRow("上一版", it) }
            update?.let { InfoRow("更新通道", "${it.channel} · ${it.ref}") }
            if (release?.lastUpdateStatus != null) {
                InfoRow(
                    "最近更新",
                    "${release.lastUpdateStatus}${release.lastUpdateAt?.let { " · $it" } ?: ""}" +
                        (release.lastUpdateMessage?.let { "\n$it" } ?: ""),
                )
            }
            if (release?.pending != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                    SecondaryButton(
                        text = "应用 pending",
                        modifier = Modifier.weight(1f),
                        enabled = vm.opsActionBusy == null,
                        onClick = { onConfirm("restart", "应用 pending 并重启") },
                    )
                    SecondaryButton(
                        text = "丢弃 pending",
                        modifier = Modifier.weight(1f),
                        enabled = vm.opsActionBusy == null,
                        onClick = { onConfirm("cancel-pending", "丢弃 pending") },
                    )
                }
            }
            if (release?.previous != null && release.pending == null) {
                SecondaryButton(
                    text = "回滚到上一版",
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    enabled = vm.opsActionBusy == null,
                    onClick = { onConfirm("rollback", "回滚版本") },
                )
            }
        }
    }
}

@Composable
private fun StartupCard(check: StartupCheck) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("启动自检", style = MaterialTheme.typography.titleSmall)
            InfoRow("时间", check.at ?: "—")
            InfoRow("版本", listOfNotNull(check.version, check.commit?.take(8), check.release).joinToString(" · "))
            InfoRow("PID", check.pid?.toString() ?: "—")
            check.migration?.let { InfoRow("数据迁移", if (it.ok) "通过" else "失败：${it.message ?: ""}") }
            if (!check.failure.isNullOrBlank()) {
                Text(check.failure, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (check.notes.isNotEmpty()) InfoRow("说明", check.notes.joinToString("\n"))
        }
    }
}

@Composable
private fun DiagnosticsCard(diag: Diagnostics) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("环境诊断", style = MaterialTheme.typography.titleSmall)
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
            diag.memory?.let { mem ->
                InfoRow("内存", "${formatBytes(mem.freeBytes)} 可用 / ${formatBytes(mem.totalBytes)}")
            }
            if (diag.lastBackupAt > 0) {
                InfoRow("最近备份", ApiFormat.epochMsToLocalString(diag.lastBackupAt))
            }
            val log = diag.log
            if (log != null) InfoRow("Bot 日志", "${formatBytes(log.bytes)} · ${log.path ?: "—"}")
            diag.opencodeLog?.let { InfoRow("OpenCode 日志", "${formatBytes(it.bytes)} · ${it.path ?: "—"}") }
        }
    }
}

@Composable
private fun LogCard(vm: AppViewModel) {
    AppCard {
        Column {
            Text("日志", style = MaterialTheme.typography.titleSmall)
            Row(
                modifier = Modifier.padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ChoicePill(
                    text = "Bot",
                    selected = vm.logSource == "bot",
                    onClick = { vm.refreshLogs("bot", vm.logLines) },
                )
                ChoicePill(
                    text = "OpenCode",
                    selected = vm.logSource == "opencode",
                    onClick = { vm.refreshLogs("opencode", vm.logLines) },
                )
                LOG_LINE_CHOICES.forEach { count ->
                    ChoicePill(
                        text = "$count",
                        selected = vm.logLines == count,
                        onClick = { vm.refreshLogs(vm.logSource, count) },
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
