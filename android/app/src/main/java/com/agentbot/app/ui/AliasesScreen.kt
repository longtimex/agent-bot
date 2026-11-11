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
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Keyboard
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
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.AliasEntry
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's /alias panel: per-chat /name shortcuts that expand before submitting. */
@Composable
fun AliasesScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "快捷指令",
            subtitle = "输入 /名称 立即展开为常用任务",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "新建快捷指令",
                    onClick = {
                        vm.aliasesActionError = null
                        vm.aliasesDraftRejected = false
                        adding = true
                    },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新快捷指令",
                    onClick = vm::refreshAliases,
                )
            }
        )

        Text(
            "在聊天中发送 /名称 即可触发（输入 / 也能从命令列表中点选）。已连接 Telegram 或飞书时与所有者会话共享列表；仅安卓端时保存在本 App 会话中。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

        PageErrorNotice(
            message = vm.aliasesActionError,
            onDismiss = { vm.aliasesActionError = null },
        )

        val loadError = vm.aliasesError
        if (loadError != null) {
            PageLoadError(
                title = "暂时无法加载快捷指令",
                message = loadError,
                icon = Icons.Filled.Keyboard,
                onRetry = vm::refreshAliases,
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
            ) {
                if (vm.aliases.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Filled.Keyboard,
                            title = "还没有快捷指令",
                            message = "新建后发送 /名称 即可展开，例如 code → 审查当前目录的代码。",
                        )
                    }
                }
                items(vm.aliases, key = { it.name }) { alias ->
                    AliasCard(alias, onDelete = {
                        vm.aliasesActionError = null
                        pendingRemove = alias.name
                    })
                }
            }
        }
    }

    if (adding) {
        TextPromptDialog(
            title = "新建快捷指令",
            hint = "格式：名称 指令内容。名称限小写字母、数字、下划线（字母开头，2–32 位），且不能与内置命令重名；发送 /名称 即触发。",
            confirmLabel = "创建",
            placeholder = "code 审查当前目录的代码",
            error = vm.aliasesActionError.takeIf { vm.aliasesDraftRejected },
            onDismiss = {
                adding = false
                vm.aliasesActionError = null
                vm.aliasesDraftRejected = false
            },
            onConfirm = { input ->
                vm.addAlias(input) { ok -> if (ok) adding = false }
            },
        )
    }

    pendingRemove?.let { name ->
        AlertDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("删除快捷指令 /$name？", style = MaterialTheme.typography.titleLarge) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("删除后发送 /$name 将不再展开，且无法恢复。", style = MaterialTheme.typography.bodyMedium)
                    vm.aliasesActionError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteAlias(name) { ok -> if (ok) pendingRemove = null }
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemove = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun AliasCard(alias: AliasEntry, onDelete: () -> Unit) {
    AppCard(contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "/${alias.name}",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            StatusPill(text = "自定义")
        }
        Text(
            alias.expansion,
            color = TextTertiary,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 3,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(modifier = Modifier.padding(top = 7.dp)) {
            QuietButton(
                text = "删除",
                icon = Icons.Filled.DeleteOutline,
                danger = true,
                onClick = onDelete,
            )
        }
    }
}
