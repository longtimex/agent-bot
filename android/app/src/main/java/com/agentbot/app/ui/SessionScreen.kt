package com.agentbot.app.ui

import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.agentbot.app.data.Task
import com.agentbot.app.ui.theme.TextSecondary
import kotlinx.coroutines.delay

private val TIMEZONE_PRESETS = listOf(
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Europe/London",
    "Europe/Berlin",
    "America/New_York",
    "America/Los_Angeles",
    "UTC",
)

/**
 * Session controls that match Telegram's /dir, /timezone and /model default:
 * where CLI engines run, which zone reminders use, and how to reset context.
 */
@Composable
fun SessionScreen(vm: AppViewModel) {
    var editDir by remember { mutableStateOf(false) }
    var editTz by remember { mutableStateOf(false) }
    val session = vm.session
    val dir = vm.dirInfo
    val currentTz = vm.timezone ?: session?.timezone

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("会话设置", style = MaterialTheme.typography.titleLarge)

        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                InfoRow("引擎", session?.engineLabel ?: session?.engine ?: "-")
                InfoRow("模型", session?.model ?: "-")
                InfoRow("时区", currentTz ?: "-")
                InfoRow("工作目录", dir?.workDir ?: session?.workDir ?: "-")
                InfoRow("上下文", if (session?.hasSession == true) "已有连续会话" else "新会话")
                dir?.note?.let { Text(it, color = TextSecondary, style = MaterialTheme.typography.labelMedium) }
                dir?.custom?.let {
                    Text("自定义目录：$it", color = TextSecondary, style = MaterialTheme.typography.labelMedium)
                }
                HorizontalDivider()
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { editDir = true }) { Text("修改目录") }
                    OutlinedButton(onClick = vm::resetWorkDir) { Text("恢复默认目录") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = vm::resetModel) { Text("恢复默认模型") }
                    OutlinedButton(onClick = vm::newChat) { Text("新建会话") }
                }
            }
        }

        Text("时区", style = MaterialTheme.typography.titleMedium)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "提醒、定时任务与每日统计都使用该时区，切换立即生效并写入 .env。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TIMEZONE_PRESETS.forEach { zone ->
                        FilterChip(
                            selected = zone == currentTz,
                            onClick = { vm.changeTimezone(zone) },
                            label = { Text(zone) },
                        )
                    }
                }
                OutlinedButton(onClick = { editTz = true }) { Text("自定义时区…") }
            }
        }

        Text("任务", style = MaterialTheme.typography.titleMedium)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(onClick = vm::stop) { Text("停止所有任务") }
                OutlinedButton(onClick = { vm.navigate(Screen.Queue) }) { Text("查看队列") }
            }
        }
    }

    if (editDir) {
        TextPromptDialog(
            title = "切换工作目录",
            hint = "CLI 引擎将在该目录下执行，支持 ~ 与相对路径。切换会重置该会话的 CLI 上下文。",
            initial = dir?.custom ?: "",
            confirmLabel = "保存",
            placeholder = "/data/workspace/project",
            onDismiss = { editDir = false },
            onConfirm = { path ->
                vm.setWorkDir(path)
                editDir = false
            },
        )
    }
    if (editTz) {
        TextPromptDialog(
            title = "自定义时区",
            hint = "请输入 IANA 时区名，例如 Asia/Shanghai、Europe/Berlin。",
            initial = currentTz ?: "",
            confirmLabel = "保存",
            placeholder = "Asia/Shanghai",
            onDismiss = { editTz = false },
            onConfirm = { zone ->
                vm.changeTimezone(zone.trim())
                editTz = false
            },
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            modifier = Modifier
                .weight(1f, fill = false)
                .padding(start = 16.dp),
        )
    }
}

/** Telegram's /queue: queued and running tasks with per-task stop buttons. */
@Composable
fun QueueScreen(vm: AppViewModel) {
    var confirmClear by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val active = vm.queue.isNotEmpty()
    LaunchedEffect(active) {
        now = System.currentTimeMillis()
        var ticks = 0
        while (active) {
            delay(1_000)
            now = System.currentTimeMillis()
            if (++ticks % 5 == 0) vm.pollQueue()
        }
    }
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("任务队列", style = MaterialTheme.typography.titleLarge)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (vm.queue.isNotEmpty()) {
                    TextButton(onClick = { confirmClear = true }) {
                        Icon(Icons.Filled.DeleteSweep, contentDescription = null, modifier = Modifier.size(16.dp))
                        Text(
                            "清空排队",
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                }
                TextButton(onClick = vm::refreshQueue) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        if (vm.queue.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("当前没有排队或执行中的任务", color = TextSecondary, style = MaterialTheme.typography.bodyLarge)
            }
            return@Column
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(vm.queue, key = { it.id }) { task ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f).padding(14.dp)) {
                            Text(
                                task.text.ifBlank { "（附件消息）" },
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 3,
                            )
                            val runningSince = if (task.status == "running") task.startedAt else null
                            val queuedSince = if (task.status == "queued") task.createdAt.takeIf { it > 0 } else null
                            val timing = when {
                                runningSince != null -> "已运行 ${AppViewModel.formatDuration(now - runningSince)}"
                                queuedSince != null -> "已排队 ${AppViewModel.formatDuration(now - queuedSince)}"
                                else -> null
                            }
                            Text(
                                listOfNotNull(
                                    taskStatusLabel(task),
                                    timing,
                                    task.progress,
                                    task.engine,
                                    task.model,
                                ).joinToString(" · "),
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                        IconButton(onClick = { vm.stopTask(task.id) }) {
                            Icon(
                                Icons.Filled.Stop,
                                contentDescription = "停止",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清空排队？") },
            text = { Text("只取消正在排队等待的任务，正在执行的任务不受影响。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.clearQueue()
                    confirmClear = false
                }) { Text("清空", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text("取消") }
            },
        )
    }
}

private fun taskStatusLabel(task: Task): String = when (task.status) {
    "queued" -> "排队中"
    "running" -> "执行中"
    else -> task.status
}
