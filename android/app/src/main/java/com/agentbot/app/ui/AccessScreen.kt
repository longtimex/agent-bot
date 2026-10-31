package com.agentbot.app.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's /access panel: who may drive the bot (and the app's owner chat). */
@Composable
fun AccessScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("访问白名单", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("添加", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshAccess) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        Text(
            "让对方给 Bot 发送 /start：被拒回复里会显示数字 ID。改动写入 .env 并立即生效；不能移除自己或清空白名单。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        if (vm.allowAllUsers) {
            Text(
                "⚠️ TELEGRAM_ALLOW_ALL_USERS 已开启：任何 Telegram 用户都能驱动 Bot 与运维操作，建议尽快关闭。",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (vm.accessUsers.isEmpty()) {
                item {
                    Text("（空白名单）", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                }
            }
            items(vm.accessUsers, key = { it }) { id ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("🔐 $id", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        TextButton(onClick = { pendingRemove = id }) {
                            Text("移除", color = MaterialTheme.colorScheme.error)
                        }
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
            title = { Text("移除 $id？", style = MaterialTheme.typography.titleMedium) },
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
