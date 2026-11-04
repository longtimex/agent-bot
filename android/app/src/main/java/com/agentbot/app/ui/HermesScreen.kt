package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.agentbot.app.ui.theme.TextSecondary

/** A write the screen has to confirm first: overwrite a blob, or empty it. */
private data class HermesWrite(val kind: String, val action: String, val file: String, val content: String?)

/**
 * Hermes' two memory blobs, the same files Telegram edits with `/cc hermes memory …`.
 * Everything the screen shows comes from one read, and every write returns the stored text,
 * so the editor can never drift from the server.
 */
@Composable
fun HermesScreen(vm: AppViewModel) {
    val state = vm.hermes
    // Keyed on the stored text: a toggle or a refresh of the other blob keeps this draft
    var memoryDraft by remember(state?.memory) { mutableStateOf(state?.memory.orEmpty()) }
    var userDraft by remember(state?.user) { mutableStateOf(state?.user.orEmpty()) }
    var pending by remember { mutableStateOf<HermesWrite?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Hermes 记忆", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = vm::refreshHermes) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("刷新", modifier = Modifier.padding(start = 4.dp))
            }
        }
        Text(
            "Hermes 每次会话都会读这两份记忆；写入立即生效，停用只是跳过，不会删除内容。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        if (vm.hermesBusy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp))
        }
        vm.hermesMessage?.let { message ->
            Text(
                message,
                color = if (message.startsWith("⚠️")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        }
        if (state == null) {
            Text(
                if (vm.hermesBusy) "正在读取记忆…" else "点右上角「刷新」读取 MEMORY.md 与 USER.md。",
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
        } else {
            Card(modifier = Modifier.padding(horizontal = 16.dp)) {
                Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                    Text("cc-switch 用量摘要", style = MaterialTheme.typography.titleSmall)
                    SelectionContainer {
                        Text(
                            state.limits.ifBlank { "（无输出）" },
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
            HermesBlobCard(
                title = "工作记忆",
                file = "MEMORY.md",
                stored = state.memory,
                draft = memoryDraft,
                enabled = state.memoryEnabled,
                busy = vm.hermesBusy,
                onDraft = { memoryDraft = it },
                onSave = { pending = HermesWrite("memory", "set", "MEMORY.md", memoryDraft) },
                onClear = { pending = HermesWrite("memory", "clear", "MEMORY.md", null) },
                onToggle = { vm.setHermesEnabled("memory", it) },
            )
            HermesBlobCard(
                title = "用户画像",
                file = "USER.md",
                stored = state.user,
                draft = userDraft,
                enabled = state.userEnabled,
                busy = vm.hermesBusy,
                onDraft = { userDraft = it },
                onSave = { pending = HermesWrite("user", "set", "USER.md", userDraft) },
                onClear = { pending = HermesWrite("user", "clear", "USER.md", null) },
                onToggle = { vm.setHermesEnabled("user", it) },
            )
        }
    }

    pending?.let { write ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(if (write.action == "set") "确认覆盖" else "确认清空", style = MaterialTheme.typography.titleMedium) },
            text = {
                Text(
                    if (write.action == "set") {
                        "将用 ${write.content?.length ?: 0} 字替换 ${write.file} 的全部内容，服务器上的旧文本不留备份。"
                    } else {
                        "将清空 ${write.file}（写入空内容），Hermes 之后读不到任何记忆。"
                    },
                    color = TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    when (write.action) {
                        "set" -> vm.saveHermes(write.kind, write.content.orEmpty())
                        else -> vm.clearHermes(write.kind)
                    }
                }) { Text(if (write.action == "set") "覆盖" else "清空") }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun HermesBlobCard(
    title: String,
    file: String,
    stored: String,
    draft: String,
    enabled: Boolean?,
    busy: Boolean,
    onDraft: (String) -> Unit,
    onSave: () -> Unit,
    onClear: () -> Unit,
    onToggle: (Boolean) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("$title · $file", style = MaterialTheme.typography.titleSmall)
                Text(
                    when (enabled) {
                        null -> "状态未知"
                        true -> "已启用"
                        false -> "已停用"
                    },
                    color = if (enabled == false) MaterialTheme.colorScheme.error else TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.fillMaxWidth(),
                minLines = 6,
                maxLines = 14,
                placeholder = { Text("（空）") },
                textStyle = MaterialTheme.typography.bodySmall,
            )
            Text(
                (if (draft.isBlank()) "尚无内容" else "当前 ${draft.length} 字") +
                    if (draft != stored) " · 有未保存的改动" else "",
                color = if (draft != stored) MaterialTheme.colorScheme.primary else TextSecondary,
                style = MaterialTheme.typography.labelMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = onSave,
                    enabled = !busy && draft != stored && draft.isNotBlank(),
                ) { Text("保存") }
                TextButton(onClick = onClear, enabled = !busy && stored.isNotBlank()) { Text("清空") }
                // Both stay usable while the state is unknown, since only cc-switch's summary
                // says which one it is and its wording is not a contract
                TextButton(onClick = { onToggle(false) }, enabled = !busy && enabled != false) { Text("停用") }
                TextButton(onClick = { onToggle(true) }, enabled = !busy && enabled != true) { Text("启用") }
            }
        }
    }
}
