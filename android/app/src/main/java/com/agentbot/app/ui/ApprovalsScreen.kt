package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Interactive high-risk approval center: switch protection mode and approve/reject live tasks. */
@Composable
fun ApprovalsScreen(vm: AppViewModel) {
    val view = vm.approvalsView
    val mode = view?.mode ?: "auto"
    val pending = view?.pending ?: emptyList()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ScreenHeader(
            title = "高危操作审批",
            subtitle = "拦截危险命令与 OpenCode 权限请求",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新审批列表",
                    onClick = vm::refreshApprovals,
                )
            },
        )

        PageErrorNotice(
            message = vm.approvalsActionError,
            onDismiss = { vm.approvalsActionError = null },
        )

        val loadError = vm.approvalsError
        if (loadError != null && view == null) {
            PageLoadError(
                title = "暂时无法读取审批中心",
                message = loadError,
                icon = Icons.Filled.Warning,
                onRetry = vm::refreshApprovals,
            )
            return@Column
        }

        if (vm.approvalsBusy && view == null) LoadingBar()

        SectionHeader(title = "防护级别")
        AppCard {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "自动模式拦截 rm -rf、git push --force、DROP TABLE、磁盘格式化等高危操作及 OpenCode 权限确认；严格模式还会拦截 sudo、发布与删除指令。",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ChoicePill(
                        text = "自动高危",
                        selected = mode == "auto",
                        onClick = { vm.setApprovalMode("auto") },
                    )
                    ChoicePill(
                        text = "严格模式",
                        selected = mode == "strict",
                        onClick = { vm.setApprovalMode("strict") },
                    )
                    ChoicePill(
                        text = "关闭",
                        selected = mode == "off",
                        onClick = { vm.setApprovalMode("off") },
                    )
                }
            }
        }

        SectionHeader(title = "待审批请求（${pending.size}）")
        if (pending.isEmpty()) {
            EmptyState(
                icon = Icons.Filled.Lock,
                title = "暂无待审批请求",
                message = "当任务命中高危规则或 OpenCode 请求敏感权限时，审批卡片会出现在这里并同步推送到聊天端。",
            )
        } else {
            pending.forEach { item ->
                AppCard {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(item.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            StatusPill(
                                text = if (item.source == "opencode") "OpenCode" else "高危防护",
                                tone = StatusTone.Warning,
                            )
                        }
                        if (item.detail.isNotBlank()) {
                            Text(
                                item.detail,
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Text(
                            "编号 ${item.id} · 请求时间 ${AppViewModel.formatTime(item.createdAt)}",
                            color = TextTertiary,
                            style = MaterialTheme.typography.labelSmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PrimaryButton(
                                text = "允许一次",
                                modifier = Modifier.weight(1f),
                                onClick = { vm.decideApproval(item.id, "once") },
                            )
                            SecondaryButton(
                                text = "本会话放行",
                                modifier = Modifier.weight(1f),
                                onClick = { vm.decideApproval(item.id, "always") },
                            )
                        }
                        SecondaryButton(
                            text = "拒绝执行",
                            danger = true,
                            modifier = Modifier.fillMaxWidth(),
                            onClick = { vm.decideApproval(item.id, "reject") },
                        )
                    }
                }
            }
        }
    }
}
