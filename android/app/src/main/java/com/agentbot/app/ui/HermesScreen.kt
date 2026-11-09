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
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Memory
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextPrimary
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

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
        ScreenHeader(
            title = "Hermes 记忆",
            subtitle = "维护跨会话的长期记忆",
            modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 8.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新 Hermes 记忆",
                    onClick = vm::refreshHermes,
                )
            },
        )
        Text(
            "Hermes 每次会话都会读这两份记忆；写入立即生效，停用只是跳过，不会删除内容。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
        )
        if (vm.hermesBusy) {
            LoadingBar(modifier = Modifier.padding(horizontal = AppSpacing.screen))
        }
        vm.hermesMessage?.let { message ->
            InlineNotice(
                text = message.removePrefix("⚠️ ").removePrefix("✅ "),
                modifier = Modifier.padding(horizontal = AppSpacing.screen),
                tone = if (message.startsWith("⚠️")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                icon = if (message.startsWith("⚠️")) Icons.Filled.Warning else Icons.Filled.Info,
            )
        }
        if (state == null) {
            EmptyState(
                icon = Icons.Filled.Memory,
                title = if (vm.hermesBusy) "正在读取记忆" else "尚未加载记忆",
                message = if (vm.hermesBusy) "正在读取 MEMORY.md 与 USER.md。" else "点右上角刷新，读取服务器上的长期记忆。",
                action = if (vm.hermesBusy) null else {
                    { QuietButton(text = "读取记忆", icon = Icons.Filled.Refresh, onClick = vm::refreshHermes) }
                },
            )
        } else {
            AppCard(modifier = Modifier.padding(horizontal = AppSpacing.screen)) {
                SectionLabel("用量摘要")
                SelectionContainer {
                    Text(
                        state.limits.ifBlank { "（无输出）" },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = TextSecondary,
                        modifier = Modifier.padding(top = 6.dp),
                    )
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
            title = { Text(if (write.action == "set") "确认覆盖" else "确认清空", style = MaterialTheme.typography.titleLarge) },
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
    AppCard(modifier = Modifier.padding(horizontal = AppSpacing.screen)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = TextPrimary)
                Text(file, color = TextTertiary, style = MaterialTheme.typography.labelSmall)
            }
            StatusPill(
                text = when (enabled) {
                    null -> "状态未知"
                    true -> "已启用"
                    false -> "已停用"
                },
                tone = when (enabled) {
                    null -> StatusTone.Neutral
                    true -> StatusTone.Success
                    false -> StatusTone.Warning
                },
            )
        }
        AppTextField(
            value = draft,
            onValueChange = onDraft,
            modifier = Modifier.padding(top = 12.dp),
            placeholder = "（空）",
            minLines = 6,
            maxLines = 14,
            monospace = true,
        )
        Text(
            (if (draft.isBlank()) "尚无内容" else "当前 ${draft.length} 字") +
                if (draft != stored) " · 有未保存的改动" else "",
            color = if (draft != stored) TextPrimary else TextTertiary,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(top = 7.dp),
        )
        Row(
            modifier = Modifier.padding(top = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            PrimaryButton(
                text = "保存",
                modifier = Modifier.weight(1f),
                enabled = !busy && draft != stored && draft.isNotBlank(),
                onClick = onSave,
            )
            QuietButton(
                text = "清空",
                icon = Icons.Filled.DeleteOutline,
                enabled = !busy && stored.isNotBlank(),
                danger = true,
                onClick = onClear,
            )
        }
        Row(
            modifier = Modifier.padding(top = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(AppSpacing.xs),
        ) {
            // Both stay usable while the state is unknown, since only cc-switch's summary
            // says which one it is and its wording is not a contract
            QuietButton(text = "停用", enabled = !busy && enabled != false, onClick = { onToggle(false) })
            QuietButton(text = "启用", enabled = !busy && enabled != true, onClick = { onToggle(true) })
        }
    }
}
