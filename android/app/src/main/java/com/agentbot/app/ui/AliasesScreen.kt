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
import com.agentbot.app.data.AliasEntry
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's /alias panel: per-chat /name shortcuts that expand before submitting. */
@Composable
fun AliasesScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("快捷指令", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("新建", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshAliases) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        Text(
            "在聊天中发送 /名称 即可触发（输入 / 也能从命令列表中点选）；与 Telegram 的 /alias 共享同一份列表。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.aliases.isEmpty()) {
                item {
                    Text(
                        "还没有自定义指令。新建后发送 /名称 即可展开，例如 code → 审查当前目录的代码。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
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
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text("/${alias.name}", style = MaterialTheme.typography.bodyLarge)
            Text(
                alias.expansion,
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { vm.deleteAlias(alias.name) }) {
                    Text("🗑 删除", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}
