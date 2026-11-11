package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ConfigEntry
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's `/env` panel: view and edit non-secret `.env` keys. */
@Composable
fun ConfigScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<ConfigEntry?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ConfigEntry?>(null) }
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "配置项",
            subtitle = "安全查看与修改服务器 .env",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "新增配置项",
                    onClick = {
                        vm.configActionError = null
                        vm.configDraftRejected = false
                        adding = true
                    },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新配置",
                    onClick = vm::refreshConfig,
                )
            }
        )

        Text(
            "仅展示可安全读取的键；密钥类值不会下发到手机。修改后部分配置需重启 Bot 才生效。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

        PageErrorNotice(
            message = vm.configActionError,
            onDismiss = { vm.configActionError = null },
        )

        if (vm.configBusy) {
            LoadingBar(
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 10.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            val view = vm.configView
            val loadError = vm.configError
            if (loadError != null) {
                item {
                    PageLoadError(
                        title = "暂时无法加载配置",
                        message = loadError,
                        icon = Icons.Filled.Edit,
                        modifier = Modifier.fillParentMaxSize(),
                        onRetry = vm::refreshConfig,
                    )
                }
            } else if (view == null) {
                item {
                    EmptyState(
                        icon = Icons.Filled.Edit,
                        title = if (vm.configBusy) "正在读取配置" else "配置尚未加载",
                        message = if (vm.configBusy) "请稍候，正在从服务器读取 .env。" else "点右上角刷新，或新增一个配置项。",
                    )
                }
            } else {
                if (!view.exists) {
                    item {
                        InlineNotice(
                            text = "服务器上还没有 .env 文件；新增一个键即可创建。",
                            icon = Icons.Filled.Edit,
                        )
                    }
                }
                items(view.entries.sortedBy { it.key }, key = { it.key }) { entry ->
                    ConfigCard(
                        entry = entry,
                        onEdit = {
                            vm.configActionError = null
                            editing = entry
                        },
                        onDelete = {
                            vm.configActionError = null
                            deleting = entry
                        },
                    )
                }
                if (view.entries.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Filled.Edit,
                            title = "还没有配置项",
                            message = "点右上角 + 添加第一个 .env 键。",
                        )
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
            error = vm.configActionError.takeIf { vm.configDraftRejected },
            onDismiss = {
                editing = null
                vm.configActionError = null
                vm.configDraftRejected = false
            },
            onConfirm = { value ->
                vm.setConfig(entry.key, value) { ok -> if (ok) editing = null }
            },
        )
    }

    if (adding) {
        TextPromptDialog(
            title = "新增配置",
            hint = "格式：KEY 值，例如 LOG_LEVEL debug。可用键由服务器校验。",
            confirmLabel = "保存",
            placeholder = "LOG_LEVEL debug",
            error = vm.configActionError.takeIf { vm.configDraftRejected },
            onDismiss = {
                adding = false
                vm.configActionError = null
                vm.configDraftRejected = false
            },
            onConfirm = { input ->
                vm.addConfig(input) { ok -> if (ok) adding = false }
            },
        )
    }

    deleting?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除配置", style = MaterialTheme.typography.titleLarge) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("将删除 ${entry.key}，重启 Bot 后恢复默认值。", color = TextSecondary)
                    vm.configActionError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.unsetConfig(entry.key) { ok -> if (ok) deleting = null }
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ConfigCard(entry: ConfigEntry, onEdit: () -> Unit, onDelete: () -> Unit) {
    AppCard(contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                entry.key,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.weight(1f),
            )
            if (!entry.editable) {
                StatusPill(text = "只读")
            } else if (entry.secret) {
                StatusPill(text = "已隐藏")
            }
        }
        Text(
            when {
                entry.secret -> "（密钥值已隐藏）"
                entry.value.isNullOrBlank() -> "（未设置值）"
                else -> entry.value
            },
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.padding(top = 5.dp),
        )
        if (!entry.editable) {
            Text(
                "此键只读" + if (entry.key == "TELEGRAM_ALLOW_USERS") "；请到「访问白名单」修改" else "",
                color = TextTertiary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 7.dp),
            )
        }
        if (entry.editable) {
            Row(
                modifier = Modifier.padding(top = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                QuietButton(text = "修改", icon = Icons.Filled.Edit, onClick = onEdit)
                Spacer(modifier = Modifier.width(AppSpacing.xxs))
                QuietButton(text = "删除", icon = Icons.Filled.DeleteOutline, danger = true, onClick = onDelete)
            }
        }
    }
}
