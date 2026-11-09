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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
                    onClick = { adding = true },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新快捷指令",
                    onClick = vm::refreshAliases,
                )
            }
        )

        Text(
            "在聊天中发送 /名称 即可触发（输入 / 也能从命令列表中点选）；与 Telegram 的 /alias 共享同一份列表。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

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
                AliasCard(vm, alias)
            }
        }
    }

    if (adding) {
        TextPromptDialog(
            title = "新建快捷指令",
            hint = "格式：名称 指令内容。名称限小写字母、数字、下划线（字母开头，2–32 位），发送 /名称 即触发。",
            confirmLabel = "创建",
            placeholder = "code 审查当前目录的代码",
            onDismiss = { adding = false },
            onConfirm = { input ->
                vm.addAlias(input)
                adding = false
            },
        )
    }
}

@Composable
private fun AliasCard(vm: AppViewModel, alias: AliasEntry) {
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
                onClick = { vm.deleteAlias(alias.name) },
            )
        }
    }
}
