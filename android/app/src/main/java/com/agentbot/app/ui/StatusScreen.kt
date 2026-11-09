package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.TextSecondary

/** Status + usage in one scrollable dashboard. */
@Composable
fun StatusScreen(vm: AppViewModel) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ScreenHeader(
            title = "运行状态",
            subtitle = "服务健康、连接信息与今日用量",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                StatusPill(
                    text = if (vm.health?.ok == true) "在线" else "离线",
                    tone = if (vm.health?.ok == true) StatusTone.Success else StatusTone.Warning,
                )
            },
        )

        val status = vm.status
        AppCard {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (status == null) {
                    Text("加载中…", color = TextSecondary)
                } else {
                    StatusLine("服务", "${vm.health?.name ?: "agent-bot"} ${vm.health?.version ?: ""}")
                    StatusLine("OpenCode 服务端", if (status.opencodeReachable == true) "✅ 可达" else "⚠️ 不可达")
                    StatusLine("运行时长", "${status.uptimeMs / 3_600_000}h ${(status.uptimeMs / 60_000) % 60}m")
                    StatusLine("时区", status.timezone ?: vm.session?.timezone ?: "-")
                    // Telegram's /status names the live task, not only the counters
                    status.activeTask?.let { task ->
                        StatusLine(
                            if (task.status == "running") "正在执行" else "排队中",
                            task.text.take(40) + if (task.text.length > 40) "…" else "",
                        )
                        task.progress?.takeIf { it.isNotBlank() }?.let { StatusLine("最新进展", it.take(60)) }
                    }
                    val retryable = status.tasksTotal - status.tasksActive
                    StatusLine(
                        "进行中任务",
                        "${status.tasksActive} 个" + if (retryable > 0) "（另有 $retryable 条可重试）" else "",
                    )
                    status.usageToday?.let {
                        StatusLine("今日任务", "${it.tasks} 次（成功 ${it.ok} · 失败 ${it.failed}）")
                    }
                }
            }
        }

        val info = vm.serverInfo
        if (info != null) {
            SectionLabel("连接信息")
            AppCard {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusLine("服务器", vm.serverUrl)
                    StatusLine("API 监听", "${info.api.bind}:${info.api.port}" + if (info.api.enabled) "" else "（未启用）")
                    StatusLine("引擎", info.engineLabel ?: info.engine ?: "-")
                    info.model?.takeIf { it.isNotBlank() }?.let { StatusLine("模型", it) }
                    StatusLine("工作目录", info.workDir ?: "-")
                    StatusLine("时区", info.timezone ?: "-")
                    StatusLine("推送聊天 ID", info.chatId?.toString() ?: "未配置")
                    StatusLine("推送用户 ID", info.userId?.toString() ?: "未配置")
                    StatusLine("会话 ID", info.sessionId ?: info.cliSessionId ?: "暂未创建")
                }
            }
        }

        val usage = vm.usage
        if (usage != null) {
            SectionLabel("使用统计")
            AppCard {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusLine("累计任务", "${usage.tasks} 次")
                    val rate = if (usage.tasks > 0) usage.ok * 100 / usage.tasks else 0
                    StatusLine("成功率", "$rate%")
                    StatusLine("平均耗时", AppViewModel.formatDuration(usage.avgMs))
                    if (usage.lastAt > 0) {
                        val last = listOfNotNull(
                            "${AppViewModel.formatDuration((vm.serverNow() - usage.lastAt).coerceAtLeast(0))}前",
                            usage.lastEngine,
                            usage.lastModel,
                        ).joinToString(" · ")
                        StatusLine("最近活动", last)
                    }
                    if (usage.engines.isNotEmpty()) {
                        val engines = usage.engines.entries
                            .sortedByDescending { it.value }
                            .joinToString("、") { "${it.key} ${it.value}" }
                        StatusLine("引擎分布", engines)
                    }
                }
            }

            if (vm.trend.isNotEmpty()) {
                SectionLabel("近 7 天")
                AppCard {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val max = vm.trend.maxOfOrNull { it.tasks }?.coerceAtLeast(1) ?: 1
                        vm.trend.forEach { day ->
                            Column {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(day.day, style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                                    Text("${day.tasks} 次", style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                                }
                                androidx.compose.material3.LinearProgressIndicator(
                                    progress = { day.tasks.toFloat() / max },
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    color = OkGreen,
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                SectionLabel("每日报告")
                androidx.compose.material3.TextButton(onClick = { vm.shareReport() }) { Text("📤 分享") }
            }
            AppCard {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusLine("日期", report.day)
                    val totals = report.totals
                    StatusLine("今日任务", "${totals.tasks} 次（成功 ${totals.ok} · 失败 ${totals.failed} · 取消 ${totals.cancelled}）")
                    if (totals.tasks > 0) StatusLine("平均耗时", AppViewModel.formatDuration(totals.avgMs))
                    if (report.byChat.isNotEmpty()) {
                        StatusLine("来源", report.byChat.joinToString(" · ") { "${it.source} ${it.usage.tasks}" })
                    }
                    // 迷你趋势条：与 Telegram 报告同款的 ▁▂▃ 字符图
                    val max = report.trend.maxOfOrNull { it.tasks }?.coerceAtLeast(1) ?: 1
                    val blocks = "▁▂▃▄▅▆▇█"
                    val spark = report.trend.joinToString("") { day ->
                        if (day.tasks == 0) "·" else blocks[minOf(blocks.length - 1, day.tasks * (blocks.length - 1) / max)].toString()
                    }
                    StatusLine("近 7 天", "$spark 共 ${report.trendTasks} 次")
                }
            }
        }
    }
}

@Composable
private fun StatusLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
