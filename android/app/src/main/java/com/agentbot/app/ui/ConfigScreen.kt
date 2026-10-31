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
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ConfigEntry
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's `/env` panel: view and edit non-secret `.env` keys. */
@Composable
fun ConfigScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<ConfigEntry?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ConfigEntry?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("配置项", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("新增", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshConfig) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        Text(
            "仅展示可安全读取的键；密钥类值不会下发到手机。修改后部分配置需重启 Bot 才生效。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        if (vm.configBusy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val view = vm.configView
            if (view == null) {
                item {
                    Text(
                        if (vm.configBusy) "正在读取配置…" else "暂无数据，点击刷新重试。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                if (!view.exists) {
                    item {
                        Text(
                            "服务器上还没有 .env 文件；新增一个键即可创建。",
                            color = TextSecondary,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                items(view.entries.sortedBy { it.key }, key = { it.key }) { entry ->
                    ConfigCard(
                        entry = entry,
                        onEdit = { editing = entry },
                        onDelete = { deleting = entry },
                    )
                }
                if (view.entries.isEmpty()) {
                    item {
                        Text("还没有配置项。", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }

    editing?.let { entry ->
        TextPromptDialog(
            title = "修改 ${entry.key}",
            hint = "写入 .env；值不能包含换行。",
            confirmLabel = "保存",
            initial = entry.value.orEmpty(),
            placeholder = entry.value.orEmpty(),
            onDismiss = { editing = null },
            onConfirm = { value ->
                vm.setConfig(entry.key, value)
                editing = null
            },
        )
    }

    if (adding) {
        TextPromptDialog(
            title = "新增配置",
            hint = "格式：KEY 值，例如 LOG_LEVEL debug。可用键由服务器校验。",
            confirmLabel = "保存",
            placeholder = "LOG_LEVEL debug",
            onDismiss = { adding = false },
            onConfirm = { input ->
                vm.addConfig(input)
                adding = false
            },
        )
    }

    deleting?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除配置", style = MaterialTheme.typography.titleMedium) },
            text = { Text("将删除 ${entry.key}，重启 Bot 后恢复默认值。", color = TextSecondary) },
            confirmButton = {
                TextButton(onClick = {
                    vm.unsetConfig(entry.key)
                    deleting = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ConfigCard(entry: ConfigEntry, onEdit: () -> Unit, onDelete: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(entry.key, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
            Text(
                when {
                    entry.secret -> "（密钥值已隐藏）"
                    entry.value.isNullOrBlank() -> "（未设置值）"
                    else -> entry.value
                },
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
            if (!entry.editable) {
                Text(
                    "此键只读" + if (entry.key == "TELEGRAM_ALLOW_USERS") "；请到「访问白名单」修改" else "",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            if (entry.editable) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = onEdit) { Text("修改") }
                    TextButton(onClick = onDelete) {
                        Text("🗑 删除", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}
