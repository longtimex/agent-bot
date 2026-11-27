package com.agentbot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Status + usage in one scrollable dashboard. */
@Composable
fun StatusScreen(vm: AppViewModel) {
    var editBudget by remember { mutableStateOf(false) }
    var dailyDraft by remember { mutableStateOf("") }
    var monthlyDraft by remember { mutableStateOf("") }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ScreenHeader(
            title = "运行状态",
            subtitle = "健康、连接与今日用量",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新运行状态",
                    onClick = vm::refreshStatus,
                )
            },
        )

        val status = vm.status
        val loadError = vm.statusError
        if (loadError != null) {
            PageLoadError(
                title = "暂时无法加载运行状态",
                message = loadError,
                icon = Icons.Filled.Warning,
                onRetry = vm::refreshStatus,
            )
            return@Column
        }
        if (status == null) {
            AppCard {
                Text(
                    if (vm.statusBusy) "正在读取服务器状态…" else "状态尚未加载，点右上角重试。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            // Hero: one answer to "is it healthy?" before any detail rows.
            AppCard(contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp)) {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    StatusPill(
                        text = if (status.opencodeReachable == true) "运行正常" else "需要检查",
                        tone = if (status.opencodeReachable == true) StatusTone.Success else StatusTone.Warning,
                    )
                    StatusPill(
                        text = if (vm.health?.ok == true) "在线" else "离线",
                        tone = if (vm.health?.ok == true) StatusTone.Success else StatusTone.Warning,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                    androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
                    Text(
                        status.timezone ?: vm.session?.timezone ?: "—",
                        color = TextTertiary,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Text(
                    vm.health?.name ?: "agent-bot",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(top = 14.dp),
                )
                Text(
                    "已稳定运行 ${formatUptime(status.uptimeMs)}" +
                        (vm.health?.version?.let { " · 版本 $it" } ?: ""),
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 5.dp),
                )
                Row(
                    modifier = Modifier.padding(top = 18.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MetricTile(
                        label = "进行中",
                        value = "${status.tasksActive}",
                        detail = "任务",
                        modifier = Modifier.weight(1f),
                    )
                    MetricTile(
                        label = "今日完成",
                        value = "${status.usageToday?.ok ?: 0}",
                        detail = status.usageToday?.let { "共 ${it.tasks} 次" } ?: "暂无",
                        modifier = Modifier.weight(1f),
                    )
                    MetricTile(
                        label = "可重试",
                        value = "${(status.tasksTotal - status.tasksActive).coerceAtLeast(0)}",
                        detail = "历史任务",
                        modifier = Modifier.weight(1f),
                    )
                }
                status.activeTask?.let { task ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 14.dp),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        Icon(
                            if (task.status == "running") Icons.Filled.Bolt else Icons.Filled.Schedule,
                            contentDescription = null,
                            tint = OkGreen,
                            modifier = Modifier.size(16.dp),
                        )
                        Column(modifier = Modifier.padding(start = 9.dp)) {
                            Text(
                                if (task.status == "running") "正在执行" else "排队等待",
                                style = MaterialTheme.typography.labelMedium,
                            )
                            Text(
                                task.text.take(56) + if (task.text.length > 56) "…" else "",
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        }

        val info = vm.serverInfo
        if (info != null) {
            SectionHeader(title = "连接信息", modifier = Modifier.padding(top = 8.dp))
            AppCard {
                ServerAddressRow(vm.serverUrl, Modifier.padding(bottom = 11.dp))
                androidx.compose.material3.HorizontalDivider(color = Border.copy(alpha = 0.4f))
                InfoGrid(
                    rows = listOf(
                        "API 监听" to ("${info.api.bind}:${info.api.port}" + if (info.api.enabled) "" else "（未启用）"),
                        "引擎" to (info.engineLabel ?: info.engine ?: "-"),
                        "工作目录" to (info.workDir ?: "-"),
                        "时区" to (info.timezone ?: "-"),
                        "推送聊天" to (info.chatId?.toString() ?: "未配置"),
                        "会话" to (info.sessionId ?: info.cliSessionId ?: "暂未创建"),
                    ) + listOfNotNull(info.model?.takeIf { it.isNotBlank() }?.let { "模型" to it }),
                )
            }
        }

        val usage = vm.usage
        if (usage != null) {
            SectionHeader(title = "使用统计", modifier = Modifier.padding(top = 8.dp))
            AppCard {
                val rate = if (usage.tasks > 0) usage.ok * 100 / usage.tasks else 0
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    MetricTile("累计任务", "${usage.tasks}", Modifier.weight(1f), "次")
                    MetricTile("成功率", "$rate%", Modifier.weight(1f), "任务完成", OkGreen)
                    MetricTile("平均耗时", AppViewModel.formatDuration(usage.avgMs), Modifier.weight(1f), "每次")
                }
                if (usage.lastAt > 0) {
                    val last = listOfNotNull(
                        "${AppViewModel.formatDuration((vm.serverNow() - usage.lastAt).coerceAtLeast(0))}前",
                        usage.lastEngine,
                        usage.lastModel,
                    ).joinToString(" · ")
                    DetailRow("最近活动", last, Modifier.padding(top = 14.dp))
                }
                if (usage.totalTokens > 0 || usage.costUsd > 0.0) {
                    DetailRow(
                        "Token / 费用",
                        "累计 ${formatTokensUi(usage.totalTokens)}（${formatUsdUi(usage.costUsd)}）· 今日 ${formatTokensUi(usage.today.totalTokens)}（${formatUsdUi(usage.today.costUsd)}）",
                        Modifier.padding(top = 6.dp),
                    )
                }
                if (usage.engines.isNotEmpty()) {
                    val engines = usage.engines.entries
                        .sortedByDescending { it.value }
                        .joinToString(" · ") { "${it.key} ${it.value}" }
                    DetailRow("引擎分布", engines, Modifier.padding(top = 6.dp))
                }
            }

            val budget = vm.budgetStatus
            if (budget != null) {
                SectionHeader(
                    title = "费用与预算",
                    modifier = Modifier.padding(top = 8.dp),
                    action = {
                        QuietButton(
                            text = "设置预算",
                            onClick = {
                                dailyDraft = if (budget.dailyUsd > 0) budget.dailyUsd.toString() else ""
                                monthlyDraft = if (budget.monthlyUsd > 0) budget.monthlyUsd.toString() else ""
                                editBudget = true
                            },
                        )
                    },
                )
                AppCard {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StatusPill(
                            text = when (budget.alertLevel) {
                                "exceeded" -> "已超预算"
                                "warn" -> "接近上限"
                                else -> "预算正常"
                            },
                            tone = when (budget.alertLevel) {
                                "exceeded" -> StatusTone.Error
                                "warn" -> StatusTone.Warning
                                else -> StatusTone.Success
                            },
                        )
                        Text(
                            "80% 预警 · 100% 告警",
                            color = TextTertiary,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    Row(
                        modifier = Modifier.padding(top = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        MetricTile(
                            label = "今日费用",
                            value = formatUsdUi(budget.todayUsd),
                            modifier = Modifier.weight(1f),
                            detail = if (budget.dailyUsd > 0) "上限 ${formatUsdUi(budget.dailyUsd)} (${budget.dailyPercent}%)" else "未设上限",
                        )
                        MetricTile(
                            label = "本月费用",
                            value = formatUsdUi(budget.monthUsd),
                            modifier = Modifier.weight(1f),
                            detail = if (budget.monthlyUsd > 0) "上限 ${formatUsdUi(budget.monthlyUsd)} (${budget.monthlyPercent}%)" else "未设上限",
                        )
                    }
                    DetailRow(
                        "Token 消耗",
                        "今日 ${formatTokensUi(budget.todayTokens)} · 本月 ${formatTokensUi(budget.monthTokens)}",
                        Modifier.padding(top = 10.dp),
                    )
                }
            }

            if (vm.trend.isNotEmpty()) {
                SectionHeader(title = "近 7 天", modifier = Modifier.padding(top = 8.dp))
                AppCard {
                    val max = vm.trend.maxOfOrNull { it.tasks }?.coerceAtLeast(1) ?: 1
                    Row(
                        modifier = Modifier.fillMaxWidth().height(76.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        vm.trend.forEach { day ->
                            Column(
                                modifier = Modifier.weight(1f).fillMaxHeight(),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Bottom,
                            ) {
                                Text(
                                    if (day.tasks > 0) "${day.tasks}" else "·",
                                    color = if (day.tasks > 0) TextSecondary else TextTertiary,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                                Box(
                                    modifier = Modifier
                                        .padding(top = 5.dp)
                                        .fillMaxWidth(0.48f)
                                        .height((7 + 28f * day.tasks / max).dp)
                                        .background(
                                            if (day.tasks > 0) OkGreen.copy(alpha = 0.78f) else Border.copy(alpha = 0.8f),
                                            RoundedCornerShape(4.dp),
                                        ),
                                )
                                Text(
                                    day.day.takeLast(2),
                                    color = TextTertiary,
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }
                }
            }
        }

        // Cross-chat aggregate: the same numbers the scheduled daily report pushes to Telegram
        val report = vm.dailyReport
        if (report != null) {
            SectionHeader(
                title = "每日报告",
                modifier = Modifier.padding(top = 8.dp),
                action = { QuietButton(text = "分享", onClick = { vm.shareReport() }) },
            )
            AppCard {
                val totals = report.totals
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    MetricTile("任务", "${totals.tasks}", Modifier.weight(1f), report.day)
                    MetricTile("成功", "${totals.ok}", Modifier.weight(1f), "完成", OkGreen)
                    MetricTile("失败", "${totals.failed}", Modifier.weight(1f), "${totals.cancelled} 取消")
                }
                if (totals.tasks > 0) DetailRow("平均耗时", AppViewModel.formatDuration(totals.avgMs), Modifier.padding(top = 14.dp))
                if (totals.totalTokens > 0 || totals.costUsd > 0.0) {
                    DetailRow(
                        "今日 Token / 费用",
                        "${formatTokensUi(totals.totalTokens)} · ${formatUsdUi(totals.costUsd)}",
                        Modifier.padding(top = 6.dp),
                    )
                }
                if (report.byChat.isNotEmpty()) {
                    DetailRow(
                        "来源",
                        report.byChat.joinToString(" · ") { "${it.source} ${it.usage.tasks}" },
                        Modifier.padding(top = 6.dp),
                    )
                }
                val max = report.trend.maxOfOrNull { it.tasks }?.coerceAtLeast(1) ?: 1
                val blocks = "▁▂▃▄▅▆▇█"
                val spark = report.trend.joinToString("") { day ->
                    if (day.tasks == 0) "·" else blocks[minOf(blocks.length - 1, day.tasks * (blocks.length - 1) / max)].toString()
                }
                DetailRow("近 7 天", "$spark · 共 ${report.trendTasks} 次", Modifier.padding(top = 6.dp))
            }
        }
    }

    if (editBudget) {
        AppDialog(
            onDismissRequest = { editBudget = false },
            title = { Text("设置费用预算告警") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "留空或填 0 表示关闭该上限。达到 80% 与 100% 时会向聊天端和 App 通知中心推送告警。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    AppTextField(
                        value = dailyDraft,
                        onValueChange = { dailyDraft = it },
                        label = "每日预算（美元，如 5）",
                        singleLine = true,
                    )
                    AppTextField(
                        value = monthlyDraft,
                        onValueChange = { monthlyDraft = it },
                        label = "每月预算（美元，如 80）",
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val daily = if (dailyDraft.isBlank()) 0.0 else dailyDraft.trim().toDoubleOrNull()
                    val monthly = if (monthlyDraft.isBlank()) 0.0 else monthlyDraft.trim().toDoubleOrNull()
                    if (daily == null || daily < 0 || monthly == null || monthly < 0) {
                        vm.showToast("请输入有效的非负美元金额")
                        return@TextButton
                    }
                    vm.updateBudget(daily, monthly) { ok -> if (ok) editBudget = false }
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { editBudget = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun InfoGrid(rows: List<Pair<String, String>>) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
        rows.forEachIndexed { index, (label, value) ->
            if (index > 0) {
                androidx.compose.material3.HorizontalDivider(color = Border.copy(alpha = 0.4f))
            }
            DetailRow(label, value)
        }
    }
}

/** A URL is copied verbatim, so it gets its own full-width line instead of a narrow value column. */
@Composable
private fun ServerAddressRow(url: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("服务器", color = TextTertiary, style = MaterialTheme.typography.labelMedium)
        SelectionContainer {
            Text(url, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(
            label,
            color = TextTertiary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.weight(0.34f),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.66f),
        )
    }
}

private fun formatUptime(ms: Long): String {
    val hours = ms / 3_600_000
    val minutes = (ms / 60_000) % 60
    return when {
        hours >= 24 -> "${hours / 24} 天 ${hours % 24} 小时"
        hours > 0 -> "${hours} 小时 ${minutes} 分钟"
        else -> "${minutes} 分钟"
    }
}

private fun formatTokensUi(total: Long): String = when {
    total >= 1_000_000L -> String.format("%.2fM", total / 1_000_000.0)
    total >= 10_000L -> String.format("%.1fK", total / 1_000.0)
    total >= 1_000L -> String.format("%.2fK", total / 1_000.0)
    else -> total.toString()
}

private fun formatUsdUi(usd: Double): String = when {
    usd <= 0.0 -> "$0.00"
    usd < 0.01 -> String.format("$%.4f", usd)
    usd < 1.0 -> String.format("$%.3f", usd)
    else -> String.format("$%.2f", usd)
}
