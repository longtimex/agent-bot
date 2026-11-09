package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's /access panel: who may drive the bot (and the app's owner chat). */
@Composable
fun AccessScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "访问白名单",
            subtitle = "控制谁可以驱动云端 Bot",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "添加白名单用户",
                    onClick = { adding = true },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新白名单",
                    onClick = vm::refreshAccess,
                )
            }
        )

        Text(
            "让对方给 Bot 发送 /start：被拒回复里会显示数字 ID。改动写入 .env 并立即生效；不能移除自己或清空白名单。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

        if (vm.allowAllUsers) {
            InlineNotice(
                text = "TELEGRAM_ALLOW_ALL_USERS 已开启：任何 Telegram 用户都能驱动 Bot 与运维操作，建议尽快关闭。",
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 10.dp),
                tone = MaterialTheme.colorScheme.error,
                icon = Icons.Filled.Warning,
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            if (vm.accessUsers.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.Filled.Lock,
                        title = "白名单为空",
                        message = "添加 Telegram 数字 ID 后，对方才能驱动 Bot。",
                    )
                }
            }
            items(vm.accessUsers, key = { it }) { id ->
                AppCard(contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            id,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "Telegram ID",
                            color = TextTertiary,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        QuietButton(
                            text = "移除",
                            danger = true,
                            onClick = { pendingRemove = id },
                        )
                    }
                }
            }
        }
    }

    if (adding) {
        TextPromptDialog(
            title = "添加白名单用户",
            hint = "填写对方的 Telegram 数字 ID（最多 20 位）。对方给 Bot 发 /start 时，拒绝提示里会显示这个 ID。",
            confirmLabel = "添加",
            placeholder = "123456789",
            onDismiss = { adding = false },
            onConfirm = { input ->
                vm.addAccess(input)
                adding = false
            },
        )
    }

    pendingRemove?.let { id ->
        AlertDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("移除 $id？", style = MaterialTheme.typography.titleLarge) },
            text = { Text("该用户将立即无法再使用 Bot（包括驱动任务与运维操作）。", style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    vm.removeAccess(id)
                    pendingRemove = null
                }) { Text("移除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemove = null }) { Text("取消") }
            },
        )
    }
}
