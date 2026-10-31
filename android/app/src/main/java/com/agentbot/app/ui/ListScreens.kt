package com.agentbot.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.HistoryEntry
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.data.ApiFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.delay

/** Windows offered by the history screen; the server keeps at most 50 runs. */
private val HISTORY_LIMIT_CHOICES = listOf(20, 30, 50)

private fun historyDayLabel(at: Long): String {
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    return when {
        date == today -> "今天"
        date == today.minusDays(1) -> "昨天"
        date.year == today.year -> "%02d-%02d".format(date.monthValue, date.dayOfMonth)
        else -> date.toString()
    }
}

/** "3 分钟后" style countdown so reminders/schedules need no mental math. */
private fun dueCountdown(dueAt: Long, now: Long): String? {
    if (dueAt <= 0) return null
    val diff = dueAt - now
    if (diff <= 0) return "已到时间"
    if (diff < 60_000) return "${(diff + 999) / 1000} 秒后"
    val minutes = (diff + 30_000) / 60_000
    if (minutes < 60) return "$minutes 分钟后"
    if (minutes < 1440) {
        val hours = minutes / 60
        val rest = minutes % 60
        return if (rest == 0L) "$hours 小时后" else "$hours 小时 $rest 分后"
    }
    return "${minutes / 1440} 天后"
}

/** Re-reads the clock every 30s while the screen is visible; coroutine dies with the screen. */
@Composable
private fun rememberClock(): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
fun HistoryScreen(vm: AppViewModel) {
    var selected by remember { mutableStateOf<HistoryEntry?>(null) }
    val clipboard = LocalClipboardManager.current
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("任务历史", style = MaterialTheme.typography.titleLarge)
            Row {
                var exporting by remember { mutableStateOf(false) }
                val context = androidx.compose.ui.platform.LocalContext.current
                val scope = androidx.compose.runtime.rememberCoroutineScope()
                TextButton(
                    onClick = {
                        if (exporting) return@TextButton
                        exporting = true
                        scope.launch {
                            runCatching { vm.historyExport() }
                                .onSuccess { markdown ->
                                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                        type = "text/markdown"
                                        putExtra(android.content.Intent.EXTRA_TITLE, "Agent Bot 任务历史")
                                        putExtra(android.content.Intent.EXTRA_TEXT, markdown)
                                    }
                                    context.startActivity(
                                        android.content.Intent.createChooser(send, "分享任务历史"),
                                    )
                                }
                                .onFailure { vm.connectionError = "导出失败：${it.message}" }
                            exporting = false
                        }
                    },
                ) {
                    Text(if (exporting) "导出中…" else "分享")
                }
                TextButton(onClick = { vm.clearHistory() }) { Text("清空", color = MaterialTheme.colorScheme.error) }
            }
        }
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // Same window choice Telegram offers through `/history <条数>`
                HISTORY_LIMIT_CHOICES.forEach { count ->
                    FilterChip(
                        selected = vm.historyLimit == count,
                        onClick = { vm.setHistoryLimit(count) },
                        label = { Text("$count 条") },
                    )
                }
            }
            if (vm.historyTotal > vm.history.size) {
                Text(
                    "已显示 ${vm.history.size} / 共 ${vm.historyTotal} 条，切换窗口可看到更早记录",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        if (vm.history.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("还没有任务记录", color = TextSecondary, style = MaterialTheme.typography.bodyLarge)
            }
            return@Column
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            vm.history.groupBy { historyDayLabel(it.at) }.forEach { (label, entries) ->
                item(key = "day-$label") {
                    Text(
                        label,
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                    )
                }
                items(entries, key = { it.at.toString() + it.prompt.hashCode() }) { entry ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selected = entry }
                                .padding(14.dp),
                        ) {
                            Text(entry.prompt, style = MaterialTheme.typography.bodyLarge, maxLines = 3)
                            val outcome = when (entry.outcome) {
                                "ok" -> "✅ 成功"
                                "cancelled" -> "🚫 已取消"
                                else -> "❌ 失败"
                            }
                            Text(
                                "$outcome · ${entry.engine ?: "?"}${entry.model?.let { " / $it" } ?: ""}" +
                                    (if (entry.scheduled == true) " · 🗓 定时" else "") +
                                    " · ${AppViewModel.formatDuration(entry.ms)} · ${AppViewModel.formatTime(entry.at)}",
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                    }
                }
            }
        }
        selected?.let { entry ->
            AlertDialog(
                onDismissRequest = { selected = null },
                title = { Text("任务提示词") },
                text = {
                    Text(
                        entry.prompt,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .heightIn(max = 320.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        vm.setDraft(if (vm.draft.isBlank()) entry.prompt else vm.draft.trimEnd() + "\n" + entry.prompt)
                        vm.navigate(Screen.Chat)
                        selected = null
                    }) { Text("填入输入框") }
                },
                dismissButton = {
                    TextButton(onClick = {
                        clipboard.setText(AnnotatedString(entry.prompt))
                        selected = null
                    }) { Text("复制") }
                },
            )
        }
    }
}

@Composable
fun RemindersScreen(vm: AppViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    val now = rememberClock()
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Text(
            "提醒",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
        )
        if (vm.reminders.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("还没有提醒。点右下角 + 创建。", color = TextSecondary, style = MaterialTheme.typography.bodyLarge)
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(vm.reminders, key = { it.id }) { reminder ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f).padding(14.dp)) {
                                Text(reminder.text, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    listOfNotNull(
                                        reminder.repeat?.describe(),
                                        ApiFormat.epochMsToLocalString(reminder.dueAt),
                                        dueCountdown(reminder.dueAt, now),
                                    ).joinToString(" · "),
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.labelMedium,
                                )
                            }
                            IconButton(onClick = { vm.deleteReminder(reminder.id) }) {
                                Icon(Icons.Filled.Delete, contentDescription = "删除", tint = TextSecondary)
                            }
                        }
                    }
                }
            }
        }
    }
    if (showAdd) {
        TextPromptDialog(
            title = "新建提醒",
            hint = "时间写法与 Telegram 的 /remind 一致：30m、5分钟后、18:30、明天 08:30、每天 08:30",
            onDismiss = { showAdd = false },
            onConfirm = { text ->
                vm.addReminder(text)
                showAdd = false
            },
        )
    }
    FloatingActionButtonRow(onClick = { showAdd = true })
}

@Composable
fun SchedulesScreen(vm: AppViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    val now = rememberClock()
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Text(
            "定时 AI 任务",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
        )
        Text(
            "「▶️ 运行」立即执行一次，不影响原定时间；结果会发送到 Telegram。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        if (vm.schedules.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("还没有定时任务。点右下角 + 创建。", color = TextSecondary, style = MaterialTheme.typography.bodyLarge)
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(vm.schedules, key = { it.id }) { schedule ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f).padding(14.dp)) {
                                Text(schedule.prompt, style = MaterialTheme.typography.bodyLarge, maxLines = 3)
                                Text(
                                    listOfNotNull(
                                        // Mirrors Telegram's list: which engine/model will actually run this.
                                        schedule.target?.takeIf { it.isNotBlank() }?.let { "执行 $it" },
                                        schedule.repeat?.describe() ?: "一次性",
                                        ApiFormat.epochMsToLocalString(schedule.dueAt),
                                        if (schedule.paused) "已暂停" else dueCountdown(schedule.dueAt, now),
                                        schedule.lastStatus?.let { "上次：$it" },
                                    ).joinToString(" · "),
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.labelMedium,
                                )
                            }
                            IconButton(onClick = { vm.runScheduleNow(schedule.id) }) {
                                Icon(Icons.Filled.PlayCircle, contentDescription = "立即执行", tint = TextSecondary)
                            }
                            IconButton(onClick = { vm.setSchedulePaused(schedule.id, !schedule.paused) }) {
                                Icon(
                                    if (schedule.paused) Icons.Filled.PlayArrow else Icons.Filled.Pause,
                                    contentDescription = if (schedule.paused) "恢复" else "暂停",
                                    tint = TextSecondary,
                                )
                            }
                            IconButton(onClick = { vm.deleteSchedule(schedule.id) }) {
                                Icon(Icons.Filled.Delete, contentDescription = "删除", tint = TextSecondary)
                            }
                        }
                    }
                }
            }
        }
    }
    if (showAdd) {
        ScheduleAddDialog(vm, onDismiss = { showAdd = false })
    }
    FloatingActionButtonRow(onClick = { showAdd = true })
}

/**
 * Schedule composer: the same `--engine` / `--model` flags Telegram accepts, picked from
 * native controls instead of typed. Flags must precede the time, per `parseScheduleAdd`.
 */
@Composable
private fun ScheduleAddDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var engine by remember { mutableStateOf<String?>(null) }
    var engineMenu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.refreshAgentsQuietly() }
    val engineLabel = engine?.let { id -> vm.agents.firstOrNull { it.id == id }?.label ?: id }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建定时任务") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("例如：30m 检查服务器、每天 09:00 生成日报") },
                    maxLines = 3,
                )
                Box {
                    TextButton(onClick = { engineMenu = true }) {
                        Text("引擎：${engineLabel ?: "跟随默认"}")
                    }
                    DropdownMenu(expanded = engineMenu, onDismissRequest = { engineMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("跟随默认（${vm.session?.engineLabel ?: "当前会话"}）") },
                            onClick = {
                                engine = null
                                engineMenu = false
                            },
                        )
                        vm.agents.filter { it.installed }.forEach { agent ->
                            DropdownMenuItem(
                                text = { Text(agent.label) },
                                onClick = {
                                    engine = agent.id
                                    engineMenu = false
                                },
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("模型（选填，如 gemini / sonnet）") },
                    maxLines = 1,
                )
                Text(
                    "到点由所选引擎执行并把结果发到 Telegram；留空则沿用当前会话的引擎与模型。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = text.isNotBlank(),
                onClick = {
                    val flags = listOfNotNull(
                        engine?.let { "--engine $it" },
                        model.trim().takeIf { it.isNotEmpty() }?.let { "--model $it" },
                    )
                    vm.addSchedule((flags + text.trim()).joinToString(" "))
                    onDismiss()
                },
            ) { Text("创建") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

/** Right-bottom floating action pinned above everything for the list screens. */
@Composable
private fun FloatingActionButtonRow(onClick: () -> Unit) {
    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
        androidx.compose.material3.ExtendedFloatingActionButton(
            onClick = onClick,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(20.dp),
            containerColor = MaterialTheme.colorScheme.primary,
        ) {
            Icon(Icons.Filled.Add, contentDescription = null)
            Text("新建", modifier = Modifier.padding(start = 6.dp))
        }
    }
}
