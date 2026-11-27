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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.size
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ArchivedSession
import com.agentbot.app.ui.theme.TextSecondary

/**
 * 历史会话: the sessions 新建会话 parked. Switching back restores the engine, model and the
 * Agent's own context on the server, and the bubbles this phone filed with it; the session that
 * was open is parked in its place, so a switch never loses either side.
 */
@Composable
fun SessionsScreen(vm: AppViewModel) {
    var resumeTarget by remember { mutableStateOf<ArchivedSession?>(null) }
    var deleteTarget by remember { mutableStateOf<ArchivedSession?>(null) }
    var renameTarget by remember { mutableStateOf<ArchivedSession?>(null) }
    val sessions = vm.archivedSessions
    val shown = vm.visibleArchivedSessions

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "历史会话",
            subtitle = "切回后接着聊，Agent 记得之前的上下文；来回切换两边都会保留（最多 20 个）",
            modifier = Modifier.padding(horizontal = 20.dp),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新历史会话",
                    enabled = !vm.archivedLoading,
                    onClick = vm::refreshArchivedSessions,
                )
            },
        )
        if (vm.archivedLoading) LoadingBar(modifier = Modifier.padding(horizontal = 20.dp))
        val error = vm.archivedError
        if (error != null && sessions.isEmpty() && !vm.archivedLoading) {
            PageLoadError(
                title = "暂时无法加载历史会话",
                message = error,
                icon = Icons.Filled.Forum,
                onRetry = vm::refreshArchivedSessions,
            )
            return@Column
        }
        // A failed switch or delete keeps the list it acted on, with the reason above it
        if (error != null) {
            PageErrorNotice(
                message = error,
                onDismiss = vm::clearArchivedError,
                onRetry = vm::refreshArchivedSessions,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        if (sessions.isEmpty() && !vm.archivedLoading) {
            EmptyState(
                icon = Icons.Filled.Forum,
                title = "还没有历史会话",
                message = "在会话设置里点「新建会话」时，当前会话会存到这里，之后可以随时切回。",
            )
            return@Column
        }
        AppTextField(
            value = vm.archivedQuery,
            onValueChange = vm::updateArchivedQuery,
            placeholder = "搜索标题、引擎或聊天内容",
            singleLine = true,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        if (shown.isEmpty()) {
            Text(
                "没有找到包含「${vm.archivedQuery.trim()}」的历史会话。",
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
            return@Column
        }
        LazyColumn(
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(shown, key = { it.id }) { entry ->
                val busy = vm.archivedBusyId == entry.id
                val canResume = vm.archivedBusyId == null && !entry.current
                AppCard(onClick = if (canResume) ({ resumeTarget = entry }) else null) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (entry.pinned) {
                                Icon(
                                    Icons.Filled.PushPin,
                                    contentDescription = "已置顶",
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(14.dp),
                                )
                            }
                            Text(
                                entry.title ?: "（未命名会话）",
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (entry.current) StatusPill(text = "当前", tone = StatusTone.Success)
                        }
                        Text(
                            listOfNotNull(entry.engineLabel ?: entry.engine, entry.model).joinToString(" · "),
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelMedium,
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                "存入于 ${AppViewModel.formatTime(entry.archivedAt)}" +
                                    (if (entry.stateless) " · 无上下文" else "") +
                                    if (entry.current || vm.hasArchivedTranscript(entry.id)) "" else " · 本机无聊天记录",
                                color = TextSecondary,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.weight(1f),
                            )
                            if (!entry.current) {
                                QuietButton(
                                    text = if (busy) "切换中…" else "切回",
                                    enabled = canResume,
                                    onClick = { resumeTarget = entry },
                                )
                            }
                            AppIconButton(
                                icon = Icons.Filled.PushPin,
                                contentDescription = if (entry.pinned) "取消置顶" else "置顶",
                                selected = entry.pinned,
                                enabled = vm.archivedBusyId == null,
                                onClick = { vm.toggleArchivedPin(entry) },
                            )
                            AppIconButton(
                                icon = Icons.Filled.Edit,
                                contentDescription = "重命名",
                                enabled = vm.archivedBusyId == null,
                                onClick = { renameTarget = entry },
                            )
                            AppIconButton(
                                icon = Icons.Filled.Delete,
                                contentDescription = "删除历史会话",
                                enabled = vm.archivedBusyId == null,
                                onClick = { deleteTarget = entry },
                            )
                        }
                    }
                }
            }
        }
    }

    resumeTarget?.let { entry ->
        AppDialog(
            onDismissRequest = { resumeTarget = null },
            title = { Text("切回这个会话？") },
            text = {
                Text(
                    "将恢复「${entry.title ?: "未命名会话"}」的引擎、模型和上下文。" +
                        "当前会话会存入历史会话，之后也可以切回来。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    resumeTarget = null
                    vm.resumeArchivedSession(entry.id)
                }) { Text("切回") }
            },
            dismissButton = { TextButton(onClick = { resumeTarget = null }) { Text("取消") } },
        )
    }

    renameTarget?.let { entry ->
        TextPromptDialog(
            title = "重命名会话",
            hint = "在列表里显示的名称，最多 60 字。",
            initial = entry.title.orEmpty(),
            placeholder = "例如：发布计划",
            confirmLabel = "保存",
            maxLines = 1,
            onDismiss = { renameTarget = null },
            onConfirm = { name ->
                renameTarget = null
                vm.renameArchivedSession(entry.id, name)
            },
        )
    }

    deleteTarget?.let { entry ->
        AppDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除这个历史会话？") },
            text = { Text("服务端会删除它的上下文，手机上存的聊天记录也会一起删除，且无法恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    deleteTarget = null
                    vm.deleteArchivedSession(entry.id)
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("取消") } },
        )
    }
}
