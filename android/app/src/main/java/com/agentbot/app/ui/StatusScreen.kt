package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("运行状态", style = MaterialTheme.typography.titleLarge)

        val status = vm.status
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (status == null) {
                    Text("加载中…", color = TextSecondary)
                } else {
                    StatusLine("服务", "${vm.health?.name ?: "agent-bot"} ${vm.health?.version ?: ""}")
                    StatusLine("OpenCode 服务端", if (status.opencodeReachable == true) "✅ 可达" else "⚠️ 不可达")
                    StatusLine("运行时长", "${status.uptimeMs / 3_600_000}h ${(status.uptimeMs / 60_000) % 60}m")
                    StatusLine("时区", status.timezone ?: vm.session?.timezone ?: "-")
                    status.usageToday?.let {
                        StatusLine("今日任务", "${it.total} 次（成功 ${it.ok} · 失败 ${it.failed}）")
                    }
                }
            }
        }

        val info = vm.serverInfo
        if (info != null) {
            Text("连接信息", style = MaterialTheme.typography.titleMedium)
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusLine("服务器", vm.serverUrl)
                    StatusLine("API 监听", "${info.api.bind}:${info.api.port}" + if (info.api.enabled) "" else "（未启用）")
                    StatusLine("引擎", info.engineLabel ?: info.engine ?: "-")
                    info.model?.takeIf { it.isNotBlank() }?.let { StatusLine("模型", it) }
                    StatusLine("工作目录", info.workDir ?: "-")
                    StatusLine("时区", info.timezone ?: "-")
                    StatusLine("推送聊天 ID", info.chatId?.toString() ?: "未配置")
                    StatusLine("会话 ID", info.sessionId ?: info.cliSessionId ?: "暂未创建")
                }
            }
        }

        val usage = vm.usage
        if (usage != null) {
            Text("使用统计", style = MaterialTheme.typography.titleMedium)
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusLine("累计任务", "${usage.total} 次")
                    val rate = if (usage.total > 0) usage.ok * 100 / usage.total else 0
                    StatusLine("成功率", "$rate%")
                    StatusLine("平均耗时", AppViewModel.formatDuration(usage.avgMs))
                    if (usage.engines.isNotEmpty()) {
                        val engines = usage.engines.entries
                            .sortedByDescending { it.value }
                            .joinToString("、") { "${it.key} ${it.value}" }
                        StatusLine("引擎分布", engines)
                    }
                }
            }

            if (vm.trend.isNotEmpty()) {
                Text("近 7 天", style = MaterialTheme.typography.titleMedium)
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val max = vm.trend.maxOfOrNull { it.total }?.coerceAtLeast(1) ?: 1
                        vm.trend.forEach { day ->
                            Column {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(day.day, style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                                    Text("${day.total} 次", style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                                }
                                androidx.compose.material3.LinearProgressIndicator(
                                    progress = { day.total.toFloat() / max },
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    color = OkGreen,
                                )
                            }
                        }
                    }
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
