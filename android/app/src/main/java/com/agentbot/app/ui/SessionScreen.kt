package com.agentbot.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.Peer
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
    var browseDir by remember { mutableStateOf(false) }
    var editTz by remember { mutableStateOf(false) }
    var followTarget by remember { mutableStateOf<Peer?>(null) }
    val session = vm.session
    val dir = vm.dirInfo
    val currentTz = vm.timezone ?: session?.timezone
    val others = vm.peers.filter { !it.current }
    // Peer ages are drawn once per reload (navigation, 刷新, foreground) — no ticking clock here.
    val now = System.currentTimeMillis()

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
                InfoRow("模型", session?.modelLine ?: "-")
                InfoRow("时区", currentTz ?: "-")
                InfoRow("工作目录", dir?.workDir ?: session?.workDir ?: "-")
                InfoRow("上下文", if (session?.hasSession == true) "已有连续会话" else "新会话")
                dir?.note?.let { Text(it, color = TextSecondary, style = MaterialTheme.typography.labelMedium) }
                dir?.custom?.let {
                    Text("自定义目录：$it", color = TextSecondary, style = MaterialTheme.typography.labelMedium)
                }
                // Typing an absolute path is the awkward part of changing this on a phone
                TextButton(
                    onClick = {
                        vm.openDirBrowser()
                        browseDir = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("浏览服务器目录…")
                }
                HorizontalDivider()
                if (vm.hasLiveTask) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "任务执行中：恢复默认模型、新建会话与改动工作目录需要先停止任务；切换引擎不受影响。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = vm::stop) { Text("停止") }
                    }
                }
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

        if (others.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("另一端会话", style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = vm::refreshPeers) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
            others.forEach { peer ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(peer.label, style = MaterialTheme.typography.titleSmall)
                        InfoRow("引擎", peer.session?.engineLabel ?: peer.session?.engine ?: "-")
                        InfoRow("模型", peer.session?.modelLine ?: "-")
                        InfoRow("工作目录", peer.session?.workDir ?: "-")
                        InfoRow("上下文", if (peer.session?.hasSession == true) "已有连续会话" else "新会话")
                        InfoRow(
                            "最近活动",
                            peer.activity?.let { activity ->
                                if (activity.lastAt <= 0) "尚无记录"
                                else "${AppViewModel.formatDuration((now - activity.lastAt).coerceAtLeast(0))}前 · ${activity.lastEngine ?: "-"}"
                            } ?: "-",
                        )
                        InfoRow(
                            "任务统计",
                            peer.activity?.let { activity ->
                                "今日 ${activity.todayOk}/${activity.todayTasks} · 累计 ${activity.totalTasks}"
                            } ?: "-",
                        )
                        OutlinedButton(onClick = { followTarget = peer }) { Text("跟随该会话") }
                    }
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
    if (browseDir) {
        DirBrowserDialog(vm, onDismiss = {
            browseDir = false
            vm.closeDirBrowser()
        })
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
    followTarget?.let { peer ->
        AlertDialog(
            onDismissRequest = { followTarget = null },
            title = { Text("跟随${peer.label}？") },
            text = {
                Text(
                    "会把本机 App 改成「${peer.session?.engineLabel ?: peer.session?.engine ?: "-"} · " +
                        "${peer.session?.model ?: "-"} · ${peer.session?.workDir ?: "-"}」，" +
                        "并重置 App 侧的 CLI 上下文。另一端不会有任何改动。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.followPeer(peer.scope)
                    followTarget = null
                }) { Text("跟随") }
            },
            dismissButton = {
                TextButton(onClick = { followTarget = null }) { Text("取消") }
            },
        )
    }
}

/**
 * The picker behind 「浏览服务器目录…」: walks the server's tree one level at a time, then hands
 * the chosen path to the same `POST /dir` the typed dialog uses. Reading a listing never touches
 * the session, so wandering around costs nothing.
 */
@Composable
private fun DirBrowserDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    val listing = vm.dirBrowse
    val busy = vm.dirBrowseBusy
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择工作目录") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "CLI 引擎将在选定的目录下执行，切换会重置该会话的 CLI 上下文。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    listing?.path ?: "读取中…",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                listing?.sessionDir?.takeIf { it.isNotEmpty() }?.let {
                    Text("当前会话：$it", color = TextSecondary, style = MaterialTheme.typography.labelMedium)
                }
                vm.dirBrowseError?.let {
                    Text(it, color = Color.Red, style = MaterialTheme.typography.bodySmall)
                }
                if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    TextButton(onClick = { vm.loadDir("") }, enabled = !busy) { Text("默认") }
                    listing?.home?.takeIf { it.isNotEmpty() }?.let {
                        TextButton(onClick = { vm.loadDir(it) }, enabled = !busy) { Text("主目录") }
                    }
                    listing?.cwd?.takeIf { it.isNotEmpty() }?.let {
                        TextButton(onClick = { vm.loadDir(it) }, enabled = !busy) { Text("运行目录") }
                    }
                    listing?.parent?.let {
                        TextButton(onClick = { vm.loadDir(it) }, enabled = !busy) { Text("上一级") }
                    }
                }
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(240.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    listing?.dirs?.forEach { entry ->
                        TextButton(
                            onClick = { vm.loadDir(entry.path) },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                entry.name,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    if (listing != null && !busy && listing.dirs.isEmpty()) {
                        Text(
                            "该目录下没有子目录",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (listing != null && listing.truncated) {
                        Text(
                            "子目录过多，仅列出前 ${listing.dirs.size} 个；其余请用「修改目录」手打路径。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { listing?.let { vm.chooseDir(it.path) } },
                enabled = listing != null && !busy,
            ) { Text("选择此目录") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
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

/** Telegram's /queue: queued and running tasks with per-task stop buttons, plus recent finished records to re-run. */
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

        if (vm.queue.isEmpty() && vm.recentTasks.isEmpty()) {
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
            if (vm.recentTasks.isNotEmpty()) {
                item {
                    Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                        Text("最近任务", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "「重试」按服务器里保存的原提示重发，附件与临时模型选择都跟着走。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
                items(vm.recentTasks, key = { it.id }) { task ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f).padding(14.dp)) {
                                Text(
                                    task.text.ifBlank { "（附件消息）" },
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 2,
                                )
                                val took = task.startedAt?.let { start ->
                                    task.finishedAt?.let { end -> AppViewModel.formatDuration(end - start) }
                                }
                                Text(
                                    listOfNotNull(
                                        taskStatusLabel(task),
                                        took?.let { "耗时 $it" },
                                        task.finishedAt?.let { AppViewModel.formatTime(it) },
                                        task.engine,
                                        task.model,
                                        task.attachmentCount?.takeIf { it > 0 }?.let { "附件 $it" },
                                    ).joinToString(" · "),
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                                task.error?.takeIf { it.isNotBlank() }?.let {
                                    Text(
                                        it,
                                        color = MaterialTheme.colorScheme.error,
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 2,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }
                            }
                            TextButton(onClick = { vm.retryRecord(task.id) }) { Text("重试") }
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
    "done" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    else -> task.status
}
