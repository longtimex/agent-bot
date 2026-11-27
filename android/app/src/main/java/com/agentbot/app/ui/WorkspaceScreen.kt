package com.agentbot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentbot.app.data.WorkspaceFileDiff
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Code diff viewer + persistent undo stack + confirmed git commit. */
@Composable
fun WorkspaceScreen(vm: AppViewModel) {
    var confirmUndo by remember { mutableStateOf(false) }
    var showCommit by remember { mutableStateOf(false) }
    var commitMessage by remember { mutableStateOf("") }
    val diff = vm.workspaceDiff
    val error = vm.workspaceError
    val fileKeys = diff?.files?.map { it.path }
    var expanded by remember(diff?.root, fileKeys) {
        mutableStateOf(
            if (diff != null && diff.files.size <= 2) diff.files.map { it.path }.toSet() else emptySet(),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = AppSpacing.screen, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ScreenHeader(
            title = "代码改动",
            subtitle = "查看 Diff、多步撤销与一键提交",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新代码改动",
                    enabled = !vm.workspaceBusy,
                    onClick = vm::refreshWorkspace,
                )
            },
        )
        if (vm.workspaceBusy) LoadingBar()

        if (error != null && diff == null && !vm.workspaceBusy) {
            PageLoadError(
                title = "暂时无法读取工作区改动",
                message = error,
                icon = Icons.Filled.Warning,
                onRetry = vm::refreshWorkspace,
            )
            return@Column
        }
        val noticeError = error ?: vm.connectionError
        if (noticeError != null) {
            PageErrorNotice(
                message = noticeError,
                onDismiss = {
                    if (error != null) vm.clearWorkspaceError() else vm.connectionError = null
                },
            )
        }

        if (diff == null) {
            EmptyState(
                icon = Icons.Filled.Code,
                title = if (vm.workspaceBusy) "正在读取 Diff" else "尚未加载",
                message = "点击右上角刷新工作区 git 改动。",
            )
            return@Column
        }

        AppCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusPill(
                        text = if (diff.count > 0) "${diff.count} 个文件" else "工作区干净",
                        tone = if (diff.count > 0) StatusTone.Warning else StatusTone.Success,
                    )
                    if (diff.count > 0) {
                        Text(
                            "+${diff.added}  −${diff.removed}",
                            color = OkGreen,
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    if (diff.recordsCount > 0) {
                        StatusPill(text = "撤销栈 ${diff.recordsCount}", tone = StatusTone.Neutral)
                    }
                }
                diff.root?.let { root ->
                    Text(
                        "仓库：$root" + (diff.head?.let { " · HEAD $it" } ?: ""),
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (diff.count > 0) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton(
                            text = "撤销上次改动",
                            enabled = diff.undoable && !vm.hasLiveTask && !vm.workspaceBusy,
                            modifier = Modifier.weight(1f),
                            onClick = { confirmUndo = true },
                        )
                        PrimaryButton(
                            text = "提交 Commit",
                            enabled = !vm.hasLiveTask && !vm.workspaceBusy,
                            modifier = Modifier.weight(1f),
                            onClick = { showCommit = true },
                        )
                    }
                }
            }
        }

        if (diff.count == 0) {
            EmptyState(
                icon = Icons.Filled.Code,
                title = "当前没有未提交改动",
                message = diff.message ?: "当 Agent 修改了 git 仓库里的文件，这里会展示逐文件 Diff 与撤销/提交操作。",
            )
        } else {
            SectionLabel("变更文件（点按展开 Diff）")
            diff.files.forEach { file ->
                val isOpen = file.path in expanded
                DiffFileCard(
                    file = file,
                    expanded = isOpen,
                    onToggle = {
                        expanded = if (file.path in expanded) expanded - file.path else expanded + file.path
                    },
                )
            }
            if (diff.truncated) {
                Text(
                    "部分长 Diff 已截断以控制移动端流量与内存占用。",
                    color = TextTertiary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }

    if (confirmUndo) {
        AppDialog(
            onDismissRequest = { confirmUndo = false },
            title = { Text("撤销上次任务改动？") },
            text = { Text("将恢复上一次任务修改的受跟踪文件并删除其新建的文件，该操作不可逆。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUndo = false
                    vm.undoChanges()
                }) { Text("确认撤销") }
            },
            dismissButton = { TextButton(onClick = { confirmUndo = false }) { Text("取消") } },
        )
    }

    if (showCommit) {
        AppDialog(
            onDismissRequest = { showCommit = false },
            title = { Text("提交工作区改动") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("将执行 git add -A && git commit。", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
                    AppTextField(
                        value = commitMessage,
                        onValueChange = { commitMessage = it },
                        label = "提交说明",
                        placeholder = "例如：fix: 修复登录超时问题",
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = commitMessage.trim().isNotEmpty(),
                    onClick = {
                        val msg = commitMessage.trim()
                        showCommit = false
                        commitMessage = ""
                        vm.commitChanges(msg)
                    },
                ) { Text("确认提交") }
            },
            dismissButton = { TextButton(onClick = { showCommit = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun DiffFileCard(file: WorkspaceFileDiff, expanded: Boolean, onToggle: () -> Unit) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val badge = when (file.status) {
                    "added" -> "新建"
                    "deleted" -> "删除"
                    else -> "+${file.added} −${file.removed}"
                }
                Text(
                    file.path,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    badge,
                    color = if (file.status == "deleted") MaterialTheme.colorScheme.error else OkGreen,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                )
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = TextSecondary,
                )
            }
            if (expanded && file.patch.isNotBlank()) {
                SelectionContainer {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(SurfaceHigh)
                            .horizontalScroll(rememberScrollState())
                            .padding(8.dp),
                    ) {
                        file.patch.lineSequence().forEach { line ->
                            val color = when {
                                line.startsWith("+") && !line.startsWith("+++") -> OkGreen
                                line.startsWith("-") && !line.startsWith("---") -> Color(0xFFFF6B6B)
                                line.startsWith("@@") -> Color(0xFF64B5F6)
                                else -> TextSecondary
                            }
                            Text(
                                text = line,
                                color = color,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                lineHeight = 15.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}
