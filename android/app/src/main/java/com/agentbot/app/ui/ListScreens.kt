package com.agentbot.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.IosShare
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.HistoryEntry
import com.agentbot.app.ui.theme.AppRadius
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary
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

/** Re-reads the server's clock every 30s while the screen is visible; coroutine dies with the screen. */
@Composable
private fun rememberClock(vm: AppViewModel): Long {
    var now by remember { mutableStateOf(vm.serverNow()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = vm.serverNow()
        }
    }
    return now
}

@Composable
fun HistoryScreen(vm: AppViewModel) {
    var selected by remember { mutableStateOf<HistoryEntry?>(null) }
    val clipboard = LocalClipboardManager.current
    var exporting by remember { mutableStateOf(false) }
    var actionsOpen by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    // Telegram's /export accepts md or json, so the sheet offers both
    fun share(format: String) {
        if (exporting) return
        exporting = true
        scope.launch {
            runCatching { vm.historyExport(format) }
                .onSuccess { text ->
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = if (format == "json") "application/json" else "text/markdown"
                        putExtra(android.content.Intent.EXTRA_TITLE, "Agent Bot 任务历史")
                        putExtra(android.content.Intent.EXTRA_TEXT, text)
                    }
                    context.startActivity(
                        android.content.Intent.createChooser(send, "分享任务历史"),
                    )
                }
                .onFailure { vm.connectionError = "导出失败：${it.message}" }
            exporting = false
        }
    }
    // A `/export json` typed in the chat box arrives here
    LaunchedEffect(vm.exportRequested) {
        vm.exportRequested?.let {
            vm.clearExportRequest()
            share(it)
        }
    }
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "任务历史",
            subtitle = "查看执行结果，按天归档",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                Box {
                    AppIconButton(
                        icon = Icons.Filled.MoreVert,
                        contentDescription = "历史操作",
                        enabled = !exporting,
                        onClick = { actionsOpen = true },
                    )
                    DropdownMenu(expanded = actionsOpen, onDismissRequest = { actionsOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("分享 Markdown") },
                            leadingIcon = {
                                Icon(Icons.Filled.IosShare, contentDescription = null, modifier = Modifier.size(18.dp))
                            },
                            onClick = {
                                actionsOpen = false
                                share("markdown")
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("分享 JSON") },
                            leadingIcon = {
                                Icon(Icons.Filled.IosShare, contentDescription = null, modifier = Modifier.size(18.dp))
                            },
                            onClick = {
                                actionsOpen = false
                                share("json")
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("清空历史", color = MaterialTheme.colorScheme.error) },
                            leadingIcon = {
                                Icon(
                                    Icons.Filled.Delete,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            },
                            onClick = {
                                actionsOpen = false
                                vm.clearHistory()
                            },
                        )
                    }
                }
            },
        )
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // Same window choice Telegram offers through `/history <条数>`
                HISTORY_LIMIT_CHOICES.forEach { count ->
                    ChoicePill(
                        text = "$count",
                        selected = vm.historyLimit == count,
                        onClick = { vm.updateHistoryLimit(count) },
                    )
                }
                Text("条记录", color = TextTertiary, style = MaterialTheme.typography.labelSmall)
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
                EmptyState(
                    icon = Icons.Filled.History,
                    title = "还没有任务记录",
                    message = "在聊天页发出第一条任务后，完成记录会显示在这里。",
                )
            }
            return@Column
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            vm.history.groupBy { historyDayLabel(it.at) }.forEach { (label, entries) ->
                item(key = "day-$label") {
                    SectionHeader(
                        title = label,
                        modifier = Modifier.padding(start = 2.dp, top = 14.dp, bottom = 8.dp),
                    )
                }
                items(entries, key = { it.at.toString() + it.prompt.hashCode() }) { entry ->
                    Surface(
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(AppRadius.md),
                        color = MaterialTheme.colorScheme.surface,
                        border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.66f)),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selected = entry }
                                .padding(horizontal = 15.dp, vertical = 14.dp),
                        ) {
                            Text(
                                entry.prompt,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Row(
                                modifier = Modifier.padding(top = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                StatusPill(
                                    text = when (entry.outcome) {
                                        "ok" -> "成功"
                                        "cancelled" -> "已取消"
                                        else -> "失败"
                                    },
                                    tone = when (entry.outcome) {
                                        "ok" -> StatusTone.Success
                                        "cancelled" -> StatusTone.Warning
                                        else -> StatusTone.Error
                                    },
                                )
                                if (entry.scheduled == true) StatusPill("定时")
                                Text(
                                    listOfNotNull(
                                        entry.engine,
                                        entry.model,
                                        AppViewModel.formatDuration(entry.ms),
                                        AppViewModel.formatTime(entry.at),
                                    ).joinToString(" · "),
                                    color = TextTertiary,
                                    style = MaterialTheme.typography.labelSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
        selected?.let { entry ->
            AlertDialog(
                onDismissRequest = { selected = null },
                title = { Text("任务详情") },
                text = {
                    Column(
                        modifier = Modifier
                            .heightIn(max = 380.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Text(entry.prompt, style = MaterialTheme.typography.bodyMedium)
                        if (entry.outcome != "ok") {
                            entry.errorCode?.takeIf { it.isNotBlank() }?.let { code ->
                                Text(
                                    code,
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.padding(top = 12.dp),
                                )
                            }
                            entry.detail?.takeIf { it.isNotBlank() }?.let { detail ->
                                Text(
                                    detail,
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        vm.updateDraft(if (vm.draft.isBlank()) entry.prompt else vm.draft.trimEnd() + "\n" + entry.prompt)
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
    var snoozeTarget by remember { mutableStateOf<com.agentbot.app.data.Reminder?>(null) }
    val now = rememberClock(vm)
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "提醒",
            subtitle = "到点由服务器推送，不依赖 App 在线",
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            onBack = { vm.navigate(Screen.Chat) },
        )
        if (vm.reminders.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                EmptyState(
                    icon = Icons.Filled.Notifications,
                    title = "还没有提醒",
                    message = "点右下角 + 创建，支持 30m、明早 8 点等自然时间。",
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(vm.reminders, key = { it.id }) { reminder ->
                    AppCard(contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 4.dp),
                            ) {
                                Text(reminder.text, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    listOfNotNull(
                                        reminder.repeat?.describe(),
                                        ApiFormat.epochMsToLocalString(reminder.dueAt),
                                        dueCountdown(reminder.dueAt, now),
                                    ).joinToString(" · "),
                                    color = TextTertiary,
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier.padding(top = 5.dp),
                                )
                            }
                            // 一次性提醒可延后（与 Telegram 投递按钮同款时长）；重复提醒保持周期
                            if (reminder.repeat == null) {
                                QuietButton(text = "延后", onClick = { snoozeTarget = reminder })
                            }
                            AppIconButton(
                                icon = Icons.Filled.Delete,
                                contentDescription = "删除",
                                onClick = { vm.deleteReminder(reminder.id) },
                            )
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
    snoozeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { snoozeTarget = null },
            title = { Text("延后提醒") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(target.text, style = MaterialTheme.typography.bodyMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("10 分钟" to 10, "1 小时" to 60, "明天" to 1440).forEach { (label, minutes) ->
                            TextButton(onClick = {
                                vm.snoozeReminder(target.id, minutes)
                                snoozeTarget = null
                            }) { Text(label) }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { snoozeTarget = null }) { Text("取消") }
            },
        )
    }
    FloatingActionButtonRow(onClick = { showAdd = true })
}

@Composable
fun SchedulesScreen(vm: AppViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    val now = rememberClock(vm)
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "定时 AI 任务",
            subtitle = "按计划自动执行，结果推送到 Telegram",
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            onBack = { vm.navigate(Screen.Chat) },
        )
        Text(
            "点播放可立即执行一次，不影响原定时间。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp),
        )
        if (vm.schedules.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                EmptyState(
                    icon = Icons.Filled.Schedule,
                    title = "还没有定时任务",
                    message = "点右下角 + 创建，让 Agent 按计划自动执行并推送结果。",
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(vm.schedules, key = { it.id }) { schedule ->
                    AppCard(contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 2.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        schedule.prompt,
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (schedule.paused) {
                                        StatusPill("已暂停", modifier = Modifier.padding(start = 8.dp))
                                    }
                                }
                                Text(
                                    listOfNotNull(
                                        // Mirrors Telegram's list: which engine/model will actually run this.
                                        schedule.target?.takeIf { it.isNotBlank() }?.let { "执行 $it" },
                                        schedule.repeat?.describe() ?: "一次性",
                                        ApiFormat.epochMsToLocalString(schedule.dueAt),
                                        dueCountdown(schedule.dueAt, now),
                                        schedule.lastStatus?.let { "上次：$it" },
                                    ).joinToString(" · "),
                                    color = TextTertiary,
                                    style = MaterialTheme.typography.labelSmall,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(top = 5.dp),
                                )
                            }
                            AppIconButton(
                                icon = Icons.Filled.PlayCircle,
                                contentDescription = "立即执行",
                                onClick = { vm.runScheduleNow(schedule.id) },
                                enabled = !schedule.paused,
                            )
                            AppIconButton(
                                icon = if (schedule.paused) Icons.Filled.PlayArrow else Icons.Filled.Pause,
                                contentDescription = if (schedule.paused) "恢复" else "暂停",
                                onClick = { vm.setSchedulePaused(schedule.id, !schedule.paused) },
                            )
                            AppIconButton(
                                icon = Icons.Filled.Delete,
                                contentDescription = "删除",
                                onClick = { vm.deleteSchedule(schedule.id) },
                            )
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
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AppTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = "例如：30m 检查服务器、每天 09:00 生成日报",
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
                AppTextField(
                    value = model,
                    onValueChange = { model = it },
                    placeholder = "模型（选填，如 gemini / sonnet）",
                    singleLine = true,
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
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.BottomEnd) {
        Surface(
            modifier = Modifier
                .padding(20.dp)
                .clip(CircleShape)
                .clickable(onClick = onClick),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primary,
            shadowElevation = 8.dp,
        ) {
            Icon(
                Icons.Filled.Add,
                contentDescription = "新建",
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.padding(15.dp).size(24.dp),
            )
        }
    }
}
