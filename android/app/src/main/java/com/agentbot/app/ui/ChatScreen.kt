@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.agentbot.app.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.content.pm.PackageManager
import android.provider.MediaStore
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image as ComposeImage
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.agentbot.app.data.LocalStore
import com.agentbot.app.data.PendingAttachment
import com.agentbot.app.data.formatFileSize
import com.agentbot.app.data.TaskMedia
import com.agentbot.app.data.mediaMime
import com.agentbot.app.ui.theme.AccentSoft
import com.agentbot.app.ui.theme.AppRadius
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.BubbleUser
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The main Grok-style chat surface: centered column, user bubbles right, assistant markdown. */
@Composable
fun ChatScreen(vm: AppViewModel, onOpenDrawer: () -> Unit) {
    val listState = rememberLazyListState()
    val draft = vm.draft
    val context = LocalContext.current
    val running = vm.messages.any {
        it.role == ChatMessage.Role.ASSISTANT && (it.status == "queued" || it.status == "running")
    }
    LaunchedEffect(vm.sharedDraft) {
        vm.sharedDraft?.let { shared ->
            vm.updateDraft(if (draft.isBlank()) shared else draft.trimEnd() + "\n" + shared)
            vm.consumeSharedDraft()
        }
    }
    // Follow the tail only while the reader is already at the bottom, like Telegram.
    var stickToBottom by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    // In-chat search: filters locally, tapping a hit jumps back to that message.
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var jumpTo by remember { mutableStateOf<Int?>(null) }
    var highlightTaskId by remember { mutableStateOf<String?>(null) }
    val matches = remember(vm.messages, query) {
        if (query.isBlank()) emptyList()
        else vm.messages.withIndex().filter { it.value.text.contains(query, true) }
    }
    BackHandler(enabled = searching) {
        searching = false
        query = ""
    }
    LaunchedEffect(searching, jumpTo) {
        if (!searching) {
            jumpTo?.let { index ->
                if (vm.messages.isNotEmpty()) {
                    // Wait for the chat list to be composed again before scrolling it.
                    withFrameNanos { }
                    listState.animateScrollToItem(index.coerceIn(0, vm.messages.lastIndex))
                }
                jumpTo = null
            }
        }
    }

    // Completion notification tap: reveal that task's bubble instead of just the tail.
    LaunchedEffect(vm.focusTaskId) {
        val taskId = vm.focusTaskId ?: return@LaunchedEffect
        val index = vm.messages.indexOfLast { it.taskId == taskId }
        if (index >= 0) {
            searching = false
            query = ""
            stickToBottom = false
            jumpTo = index
            highlightTaskId = taskId
        }
        vm.consumeFocusTask()
    }
    LaunchedEffect(highlightTaskId) {
        if (highlightTaskId != null) {
            delay(2_500)
            highlightTaskId = null
        }
    }

    LaunchedEffect(listState) {
        snapshotFlow {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            lastVisible >= info.totalItemsCount - 2
        }.distinctUntilChanged().collect { stickToBottom = it }
    }

    // Ask once a task actually starts so background completion notices can be shown.
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(running) {
        if (running && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    LaunchedEffect(vm.messages.size, vm.messages.lastOrNull()?.status) {
        if (!searching && vm.messages.isNotEmpty() && stickToBottom) {
            listState.animateScrollToItem(vm.messages.size - 1)
        }
    }

    fun submit(text: String) {
        if (vm.send(text)) {
            stickToBottom = true
            vm.updateDraft("")
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ChatTopBar(
            vm = vm,
            onOpenDrawer = onOpenDrawer,
            searching = searching,
            onToggleSearch = {
                searching = !searching
                if (!searching) query = ""
            },
            onSuggestion = { suggestion -> vm.updateDraft(suggestion) },
        )

        if (searching) {
            ChatSearchBar(
                query = query,
                onQueryChange = { query = it },
                onClose = {
                    searching = false
                    query = ""
                },
            )
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (searching) {
                SearchResults(
                    matches = matches,
                    query = query,
                    onOpen = { index ->
                        stickToBottom = false
                        jumpTo = index
                        searching = false
                        query = ""
                    },
                )
            } else if (vm.messages.isEmpty()) {
                EmptyChat(
                    sessionLabel = vm.session?.engineLabel,
                    connected = vm.session != null && vm.connectionError == null,
                    onSuggestion = { suggestion -> vm.updateDraft(suggestion) },
                    onOpenSettings = { vm.navigate(Screen.Settings) },
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(vm.messages, key = { it.taskId ?: "local-${it.at}" }) { message ->
                        val taskId = message.taskId
                        ChatBubble(
                            message = message,
                            vm = vm,
                            highlight = taskId != null && taskId == highlightTaskId,
                            onRetry = if ((message.status == "failed" || message.status == "cancelled") && taskId != null) {
                                { vm.retryTask(taskId) }
                            } else {
                                null
                            },
                        )
                    }
                }
                if (vm.messages.isNotEmpty() && !stickToBottom) {
                    FloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(vm.messages.lastIndex) } },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "回到最新")
                    }
                }
            }
        }

        if (!searching) {
            ErrorBanner(
                message = vm.connectionError,
                onDismiss = { vm.connectionError = null },
                onRetry = { vm.retryFromBanner() },
            )

            AttachmentStrip(
                attachments = vm.pendingAttachments,
                onRemove = { vm.removeAttachment(it) },
            )

            ChatInputBar(
                vm = vm,
                draft = draft,
                onDraftChange = vm::updateDraft,
                onSend = { submit(draft) },
                onSendText = ::submit,
                running = running,
            )
        }
    }
}

@Composable
private fun ChatTopBar(
    vm: AppViewModel,
    onOpenDrawer: () -> Unit,
    searching: Boolean,
    onToggleSearch: () -> Unit,
    onSuggestion: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 6.dp, end = 6.dp, top = 4.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AppIconButton(
                icon = Icons.Filled.Menu,
                contentDescription = "菜单",
                tint = MaterialTheme.colorScheme.onBackground,
                onClick = onOpenDrawer,
            )
            ModelChip(vm)
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
            ConnectionDot(
                connected = vm.session != null && vm.connectionError == null,
                onNavigate = { vm.navigate(Screen.Settings) },
            )
            AppIconButton(
                icon = if (searching) Icons.Filled.Close else Icons.Filled.Search,
                contentDescription = if (searching) "关闭搜索" else "搜索",
                onClick = onToggleSearch,
            )
            Box {
                AppIconButton(
                    icon = Icons.Filled.MoreVert,
                    contentDescription = "更多操作",
                    onClick = { menuOpen = true },
                )
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("任务队列") },
                        leadingIcon = {
                            Icon(Icons.Filled.List, contentDescription = null, modifier = Modifier.size(18.dp))
                        },
                        onClick = {
                            menuOpen = false
                            vm.navigate(Screen.Queue)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("会话设置") },
                        leadingIcon = {
                            Icon(Icons.Filled.Tune, contentDescription = null, modifier = Modifier.size(18.dp))
                        },
                        onClick = {
                            menuOpen = false
                            vm.navigate(Screen.Session)
                        },
                    )
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("运行状态") },
                        leadingIcon = {
                            Icon(Icons.Filled.Info, contentDescription = null, modifier = Modifier.size(18.dp))
                        },
                        onClick = {
                            menuOpen = false
                            vm.navigate(Screen.Status)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("设置") },
                        leadingIcon = {
                            Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                        },
                        onClick = {
                            menuOpen = false
                            vm.navigate(Screen.Settings)
                        },
                    )
                    if (vm.messages.isEmpty()) {
                        HorizontalDivider()
                        listOf(
                            "总结一下我今天的任务进展",
                            "查看服务器当前状态并给出建议",
                            "帮我写一个自动化脚本",
                        ).forEach { suggestion ->
                            DropdownMenuItem(
                                text = { Text(suggestion, maxLines = 1) },
                                onClick = {
                                    menuOpen = false
                                    onSuggestion(suggestion)
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatSearchBar(query: String, onQueryChange: (String) -> Unit, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 8.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(18.dp),
                color = SurfaceHigh.copy(alpha = 0.5f),
                border = BorderStroke(1.dp, Border.copy(alpha = 0.72f)),
            ) {
                Row(
                    modifier = Modifier.padding(start = 14.dp, end = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = TextTertiary, modifier = Modifier.size(18.dp))
                    BasicTextField(
                        value = query,
                        onValueChange = onQueryChange,
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(focus)
                            .padding(horizontal = 10.dp, vertical = 13.dp),
                        decorationBox = { inner ->
                            Box {
                                if (query.isEmpty()) {
                                    Text("搜索当前会话…", style = MaterialTheme.typography.bodyMedium, color = TextTertiary)
                                }
                                inner()
                            }
                        },
                    )
                    if (query.isNotEmpty()) {
                        AppIconButton(
                            icon = Icons.Filled.Close,
                            contentDescription = "清空",
                            onClick = { onQueryChange("") },
                        )
                    }
                }
            }
            QuietButton(text = "取消", onClick = onClose)
        }
    }
}

/** Search hits as tappable cards; tapping one closes search and scrolls the chat to it. */
@Composable
private fun SearchResults(matches: List<IndexedValue<ChatMessage>>, query: String, onOpen: (Int) -> Unit) {
    if (query.isBlank()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Text(
                "输入关键词搜索全部消息",
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 48.dp),
            )
        }
        return
    }
    if (matches.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Text(
                "没有找到包含「$query」的消息",
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 48.dp),
            )
        }
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "search-count") {
            Text(
                "${matches.size} 条结果",
                color = TextSecondary,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(bottom = 2.dp),
            )
        }
        items(matches, key = { it.value.taskId ?: "local-${it.value.at}" }) { indexed ->
            val message = indexed.value
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(AppRadius.md),
                border = BorderStroke(1.dp, Border.copy(alpha = 0.62f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(AppRadius.md))
                    .clickable { onOpen(indexed.index) },
            ) {
                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Row {
                        Text(
                            if (message.role == ChatMessage.Role.USER) "你" else "助手",
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelMedium,
                        )
                        androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
                        Text(
                            AppViewModel.formatTime(message.at),
                            color = TextSecondary.copy(alpha = 0.7f),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    Text(
                        snippet(message.text, query),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

/** A short excerpt around the first case-insensitive hit. */
private fun snippet(text: String, query: String, radius: Int = 36): String {
    val hit = text.indexOf(query, ignoreCase = true)
    val flat = text.replace("\n", " ")
    if (hit < 0) return flat.take(140)
    val start = (hit - radius).coerceAtLeast(0)
    val end = (hit + query.length + radius).coerceAtMost(text.length)
    val body = text.substring(start, end).replace("\n", " ")
    return (if (start > 0) "…" else "") + body + (if (end < text.length) "…" else "")
}

@Composable
private fun ModelChip(vm: AppViewModel) {
    var showPicker by remember { mutableStateOf(false) }
    val label = vm.session?.model ?: vm.session?.engineLabel ?: "未连接"
    Surface(
        modifier = Modifier
            .widthIn(max = 270.dp)
            .clip(CircleShape)
            .clickable(onClick = { showPicker = true }),
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.72f),
        border = BorderStroke(1.dp, Border.copy(alpha = 0.7f)),
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp, end = 7.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            )
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = TextSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
    if (showPicker) {
        PickerDialog(title = "切换引擎 / 模型", onDismiss = { showPicker = false }, vm = vm)
    }
}

/** Green/red status dot; tapping it opens the settings page when things are broken. */
@Composable
private fun ConnectionDot(connected: Boolean, onNavigate: () -> Unit) {
    val state = if (connected) "已连接" else "未连接"
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .semantics { contentDescription = "$state，点击打开连接设置" }
            .clickable(onClickLabel = "打开连接设置", onClick = onNavigate),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(9.dp)
                .clip(CircleShape)
                .background(if (connected) OkGreen else MaterialTheme.colorScheme.error),
        )
    }
}

@Composable
private fun EmptyChat(
    sessionLabel: String?,
    connected: Boolean,
    onSuggestion: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(
            modifier = Modifier.size(58.dp),
            shape = CircleShape,
            color = SurfaceHigh.copy(alpha = 0.62f),
            border = BorderStroke(1.dp, Border.copy(alpha = 0.85f)),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Filled.Bolt,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(26.dp),
                )
            }
        }
        Text(
            "有什么可以帮你？",
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 20.dp),
        )
        Row(
            modifier = Modifier.padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            StatusPill(
                text = if (connected) "已连接" else "未连接",
                tone = if (connected) StatusTone.Success else StatusTone.Error,
            )
            StatusPill(
                text = sessionLabel?.takeIf { it.isNotBlank() } ?: "默认引擎",
                tone = StatusTone.Neutral,
            )
        }
        Text(
            if (connected) "发消息开始任务，或从下面选一个常用入口。" else "先完成配对，再开始对话。",
            style = MaterialTheme.typography.bodyMedium,
            color = TextSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 14.dp),
        )
        // An unpaired chat cannot submit anything. Showing prompts here would look like a
        // working inbox whose buttons silently only fill a draft, so lead with the instructions
        // that actually enable the screen.
        if (!connected) {
            Text(
                "先在「设置」填写服务器地址与访问令牌，连接后即可发送消息、传附件并接收任务进度。",
                style = MaterialTheme.typography.bodySmall,
                color = TextSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 18.dp),
            )
            SecondaryButton(
                text = "打开设置",
                modifier = Modifier.padding(top = 14.dp),
                onClick = onOpenSettings,
            )
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 26.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                listOf(
                    "总结一下我今天的任务进展",
                    "查看服务器当前状态并给出建议",
                    "帮我写一个自动化脚本",
                ).forEach { suggestion ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(AppRadius.md))
                            .clickable { onSuggestion(suggestion) },
                        shape = RoundedCornerShape(AppRadius.md),
                        color = Color.Transparent,
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 13.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.ArrowUpward,
                                contentDescription = null,
                                tint = TextTertiary,
                                modifier = Modifier.size(15.dp),
                            )
                            Text(
                                suggestion,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f).padding(start = 10.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
/** Long-press anywhere on a bubble to copy its full text, like the Grok app. */
private fun Modifier.copyOnLongPress(
    clipboard: androidx.compose.ui.platform.ClipboardManager,
    context: Context,
    text: String,
): Modifier =
    combinedClickable(
        onClick = {},
        onLongClick = {
            clipboard.setText(androidx.compose.ui.text.AnnotatedString(text))
            android.widget.Toast.makeText(context, "已复制", android.widget.Toast.LENGTH_SHORT).show()
        },
    )

@Composable
private fun ChatBubble(vm: AppViewModel, message: ChatMessage, onRetry: (() -> Unit)? = null, highlight: Boolean = false) {
    val isUser = message.role == ChatMessage.Role.USER
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (highlight) {
                    Modifier
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f), RoundedCornerShape(14.dp))
                        .padding(vertical = 4.dp)
                } else {
                    Modifier
                }
            ),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        if (isUser) {
            Box(
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .copyOnLongPress(clipboard, context, message.text)
                    .clip(RoundedCornerShape(18.dp, 6.dp, 18.dp, 18.dp))
                    .background(BubbleUser)
                    .then(
                        Modifier.border(
                            1.dp,
                            Border.copy(alpha = 0.55f),
                            RoundedCornerShape(18.dp, 6.dp, 18.dp, 18.dp),
                        ),
                    )
                    .padding(horizontal = 15.dp, vertical = 11.dp),
            ) {
                Column {
                    if (message.text.isNotBlank()) {
                        SelectionContainer {
                            Text(message.text, color = MaterialTheme.colorScheme.onBackground)
                        }
                    }
                    if (message.attachments.isNotEmpty()) {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier.padding(top = if (message.text.isNotBlank()) 6.dp else 0.dp),
                        ) {
                            message.attachments.forEach { att ->
                                val label = when {
                                    att.mime.startsWith("audio/") -> "语音消息"
                                    att.mime.startsWith("image/") -> "图片"
                                    else -> att.name
                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        when {
                                            att.mime.startsWith("audio/") -> Icons.Filled.GraphicEq
                                            att.mime.startsWith("image/") -> Icons.Filled.Image
                                            else -> Icons.Filled.AttachFile
                                        },
                                        contentDescription = null,
                                        tint = TextSecondary,
                                        modifier = Modifier.size(14.dp),
                                    )
                                    Text(
                                        "$label · ${att.sizeLabel}",
                                        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.85f),
                                        style = MaterialTheme.typography.labelMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.padding(start = 6.dp),
                                    )
                                }
                            }
                        }
                    }
                    if (message.at > 0) {
                        Text(
                            AppViewModel.formatTime(message.at),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextSecondary.copy(alpha = 0.8f),
                            modifier = Modifier.align(Alignment.End).padding(top = 5.dp),
                        )
                    }
                }
            }
        } else {
            AssistantBubble(vm, message, onRetry)
        }
    }
}

@Composable
private fun AssistantBubble(vm: AppViewModel, message: ChatMessage, onRetry: (() -> Unit)?) {
    val status = message.status
    val clipboard = LocalClipboardManager.current
    var copied by remember(message.text) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Surface(
            modifier = Modifier.size(28.dp),
            shape = CircleShape,
            color = SurfaceHigh.copy(alpha = 0.7f),
            border = BorderStroke(1.dp, Border.copy(alpha = 0.8f)),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Filled.Bolt,
                    contentDescription = null,
                    tint = TextSecondary,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        Column(modifier = Modifier.widthIn(max = 340.dp)) {
            Row(
                modifier = Modifier.padding(start = 2.dp, bottom = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Agent",
                    style = MaterialTheme.typography.labelLarge,
                    color = TextSecondary,
                )
                when (status) {
                    "failed" -> StatusPill(
                        "失败",
                        tone = StatusTone.Error,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                    "cancelled" -> StatusPill(
                        "已停止",
                        tone = StatusTone.Warning,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(6.dp, 18.dp, 18.dp, 18.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.55f)),
            ) {
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) {
                    SelectionContainer {
                        Column {
                            when {
                                status == "queued" || status == "running" -> RunningLine(vm, message)
                                status == "failed" -> {
                                    Text(
                                        message.text.ifEmpty { "任务失败" },
                                        color = MaterialTheme.colorScheme.error,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    message.errorCode?.takeIf { it.isNotBlank() && it != "UNKNOWN" }?.let { code ->
                                        Text(
                                            "错误码：$code",
                                            color = TextSecondary,
                                            style = MaterialTheme.typography.labelSmall,
                                            modifier = Modifier.padding(top = 4.dp),
                                        )
                                    }
                                }
                                status == "cancelled" -> Text(
                                    "已停止",
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                else -> MarkdownText(message.text)
                            }
                            message.engineNote?.takeIf { it.isNotBlank() }?.let { note ->
                                Text(
                                    note,
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }
                    if (message.media.isNotEmpty() && message.taskId != null) {
                        AssistantMedia(vm, message.taskId, message.media)
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 2.dp, top = 5.dp),
            ) {
                Text(
                    AppViewModel.formatTime(message.at),
                    color = TextSecondary.copy(alpha = 0.78f),
                    style = MaterialTheme.typography.labelSmall,
                )
                if (message.text.isNotBlank()) {
                    Row(
                        modifier = Modifier
                            .padding(start = 8.dp)
                            .clip(RoundedCornerShape(7.dp))
                            .clickable {
                                clipboard.setText(AnnotatedString(message.text))
                                copied = true
                            }
                            .padding(horizontal = 5.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                            contentDescription = "复制回复",
                            tint = if (copied) MaterialTheme.colorScheme.primary else TextSecondary.copy(alpha = 0.78f),
                            modifier = Modifier.size(12.dp),
                        )
                        Text(
                            if (copied) "已复制" else "复制",
                            color = if (copied) MaterialTheme.colorScheme.primary else TextSecondary.copy(alpha = 0.78f),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(start = 3.dp),
                        )
                    }
                }
                if (onRetry != null && (status == "failed" || status == "cancelled")) {
                    QuietButton(
                        text = if (status == "cancelled") "重新执行" else "重试",
                        icon = Icons.Filled.Refresh,
                        onClick = onRetry,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
        }
    }
}

/** "● 思考中… · 已运行 12 秒" — the progress line ticks locally between polls. */
@Composable
private fun RunningLine(vm: AppViewModel, message: ChatMessage) {
    var now by remember { mutableStateOf(vm.serverNow()) }
    LaunchedEffect(message.startedAt) {
        while (true) {
            now = vm.serverNow()
            delay(1_000)
        }
    }
    val label = message.progress ?: message.text.ifEmpty {
        if (message.status == "queued") "排队中…" else "思考中…"
    }
    val elapsed = message.startedAt?.let { " · 已运行 ${AppViewModel.formatDuration(now - it)}" } ?: ""
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("● ", color = MaterialTheme.colorScheme.primary)
        Text(label + elapsed, color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
    }
}

/** Inline images plus tappable cards for voice/video/files, matching Telegram's media replies. */
@Composable
private fun AssistantMedia(vm: AppViewModel, taskId: String, media: List<TaskMedia>) {
    Column(
        modifier = Modifier.padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        media.forEach { item ->
            when {
                item.kind == "image" -> ImageMedia(vm, taskId, item)
                item.kind == "video" -> VideoMedia(vm, taskId, item)
                else -> MediaCard(vm, taskId, item)
            }
        }
    }
}

/** Videos get a large play surface; audio/files keep the compact card. */
@Composable
private fun VideoMedia(vm: AppViewModel, taskId: String, media: TaskMedia) {
    var playbackFile by remember { mutableStateOf<File?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun playInApp() {
        if (loading) return
        loading = true
        vm.withMediaFile(
            taskId,
            media,
            onReady = { file ->
                loading = false
                playbackFile = file
            },
            onFailure = { loading = false },
        )
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .widthIn(max = 300.dp)
            .fillMaxWidth()
            .clickable { playInApp() },
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(156.dp)
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.55f)),
                contentAlignment = Alignment.Center,
            ) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.size(26.dp), strokeWidth = 2.dp)
                } else {
                    Surface(shape = CircleShape, color = Color.White.copy(alpha = 0.9f)) {
                        Icon(
                            Icons.Filled.PlayArrow,
                            contentDescription = "播放视频",
                            tint = Color.Black,
                            modifier = Modifier.padding(10.dp).size(28.dp),
                        )
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Icon(Icons.Filled.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Column(modifier = Modifier.weight(1f).padding(start = 8.dp)) {
                    Text(media.name.ifEmpty { media.label }, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("视频 · ${media.sizeLabel} · 点击播放", color = TextSecondary, style = MaterialTheme.typography.labelSmall)
                }
                IconButton(onClick = { vm.openMedia(taskId, media) }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.OpenInNew, contentDescription = "用其他应用打开", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(17.dp))
                }
            }
        }
    }
    playbackFile?.let { file ->
        MediaPlayerDialog(
            file = file,
            mime = mediaMime(media.name).takeIf { it.startsWith("video/") } ?: "video/mp4",
            title = media.name.ifEmpty { media.label },
            onOpenExternal = {
                playbackFile = null
                vm.openMedia(taskId, media)
            },
            onDismiss = { playbackFile = null },
        )
    }
}

@Composable
private fun ImageMedia(vm: AppViewModel, taskId: String, media: TaskMedia) {
    val key = "$taskId/${media.index}"
    val bitmap = vm.mediaImages[key]
    val failed = key in vm.mediaErrors
    val failure = vm.mediaErrorDetails[key]
    var viewing by remember { mutableStateOf(false) }
    LaunchedEffect(key) { vm.loadMediaImage(taskId, media) }
    if (bitmap != null) {
        val image = bitmap.asImageBitmap()
        ComposeImage(
            bitmap = image,
            contentDescription = media.name.ifEmpty { media.label },
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(12.dp))
                .clickable { viewing = true },
        )
        if (viewing) {
            ImageViewerDialog(
                bitmap = image,
                title = media.name.ifEmpty { media.label },
                onOpenExternal = {
                    viewing = false
                    vm.openMedia(taskId, media)
                },
                onDismiss = { viewing = false },
            )
        }
    } else {
        Box(
            modifier = Modifier
                .size(140.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            if (failed) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    QuietButton(
                        text = "图片加载失败，重试",
                        icon = Icons.Filled.Refresh,
                        onClick = { vm.loadMediaImage(taskId, media, retry = true) },
                    )
                    failure?.takeIf { it.isNotBlank() }?.let { reason ->
                        Text(
                            reason.take(120),
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelSmall,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 4.dp, start = 8.dp, end = 8.dp),
                        )
                    }
                }
            } else {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun MediaCard(vm: AppViewModel, taskId: String, media: TaskMedia) {
    var playbackFile by remember { mutableStateOf<File?>(null) }
    var loading by remember { mutableStateOf(false) }
    val playable = media.kind == "voice" || media.kind == "audio" || media.kind == "video"
    val mime = run {
        val byName = mediaMime(media.name)
        when {
            byName != "application/octet-stream" -> byName
            media.kind == "voice" || media.kind == "audio" -> "audio/mp4"
            media.kind == "video" -> "video/mp4"
            else -> byName
        }
    }

    fun playInApp() {
        if (loading) return
        loading = true
        vm.withMediaFile(
            taskId,
            media,
            onReady = { file ->
                loading = false
                playbackFile = file
            },
            onFailure = { loading = false },
        )
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .widthIn(max = 300.dp)
            .fillMaxWidth()
            .clickable { if (playable) playInApp() else vm.openMedia(taskId, media) },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Icon(
                mediaIcon(media.kind),
                contentDescription = media.label,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(22.dp),
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            ) {
                Text(
                    media.name.ifEmpty { media.label },
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${media.label} · ${media.sizeLabel}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                IconButton(onClick = { vm.openMedia(taskId, media) }, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Filled.OpenInNew,
                        contentDescription = "用其他应用打开",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
    playbackFile?.let { file ->
        MediaPlayerDialog(
            file = file,
            mime = mime,
            title = media.name.ifEmpty { media.label },
            onOpenExternal = {
                playbackFile = null
                vm.openMedia(taskId, media)
            },
            onDismiss = { playbackFile = null },
        )
    }
}

private fun mediaIcon(kind: String) = when (kind) {
    "voice", "audio" -> Icons.Filled.GraphicEq
    "video" -> Icons.Filled.Movie
    "image" -> Icons.Filled.Image
    else -> Icons.Filled.Description
}

@Composable
private fun ErrorBanner(message: String?, onRetry: () -> Unit, onDismiss: () -> Unit) {
    if (message == null) return
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InlineNotice(
                text = message,
                tone = MaterialTheme.colorScheme.error,
                icon = Icons.Filled.Info,
                modifier = Modifier.weight(1f),
            )
            QuietButton(
                text = "重试",
                icon = Icons.Filled.Refresh,
                onClick = onRetry,
                modifier = Modifier.padding(start = 4.dp),
            )
            AppIconButton(
                icon = Icons.Filled.Close,
                contentDescription = "关闭错误提示",
                onClick = onDismiss,
            )
        }
    }
}

@Composable
private fun AttachmentStrip(attachments: List<PendingAttachment>, onRemove: (Int) -> Unit) {
    if (attachments.isEmpty()) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        attachments.forEachIndexed { index, att ->
            AttachmentChip(att = att, onRemove = { onRemove(index) })
        }
    }
}

/** Pending attachment chip with an image preview, matching Telegram's pre-send thumbnails. */
@Composable
private fun AttachmentChip(att: PendingAttachment, onRemove: () -> Unit) {
    val isImage = att.mime.startsWith("image/", ignoreCase = true)
    val isVideo = att.mime.startsWith("video/", ignoreCase = true)
    val isAudio = att.mime.startsWith("audio/", ignoreCase = true)
    val isPdf = att.mime.equals("application/pdf", ignoreCase = true)
    // The cache file is stable across recompositions and never loaded into a String.
    val thumb by produceState<ImageBitmap?>(initialValue = null, key1 = att.path, key2 = att.sizeBytes) {
        value = if (isImage) withContext(Dispatchers.IO) { decodeThumbnail(att.file) } else null
    }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
        ) {
            val preview = thumb
            when {
                preview != null -> ComposeImage(
                    bitmap = preview,
                    contentDescription = att.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
                isImage -> Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surface),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Image, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                }
                else -> {
                    val icon = when {
                        isVideo -> Icons.Filled.Movie
                        isAudio -> Icons.Filled.GraphicEq
                        isPdf -> Icons.Filled.Description
                        else -> Icons.Filled.AttachFile
                    }
                    Icon(icon, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                }
            }
            Column(modifier = Modifier.padding(start = 8.dp)) {
                Text(
                    att.name,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 150.dp),
                )
                Text(
                    formatFileSize(att.sizeBytes),
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(30.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "移除", modifier = Modifier.size(14.dp))
            }
        }
    }
}

/** Downsampled preview decoded straight from the cached file off the main thread. */
private fun decodeThumbnail(file: java.io.File): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 160 && bounds.outHeight / (sample * 2) >= 160) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeFile(file.absolutePath, opts)?.asImageBitmap()
}.getOrNull()

/** Voice notes remain short for reliable transcription and mobile recording limits. */
private const val MAX_VOICE_SECONDS = 120

/** A slash command that maps a Telegram-style chat command to a local app action. */
private data class SlashCommand(val name: String, val desc: String, val run: () -> Unit)

/** Builds the one-shot camera file and hands it to the system camera app. */
private fun launchCameraShot(
    target: MutableState<Uri?>,
    launcher: ActivityResultLauncher<Uri>,
    context: Context,
    vm: AppViewModel,
) {
    runCatching {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        // Only one shot is pending at a time and its bytes are staged in memory.
        dir.listFiles()?.forEach { it.delete() }
        val file = File.createTempFile("shot-", ".jpg", dir)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        target.value = uri
        launcher.launch(uri)
    }.onFailure {
        target.value = null
        vm.connectionError = "无法启动相机：${it.message}"
    }
}

@Composable
private fun ChatInputBar(
    vm: AppViewModel,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onSendText: (String) -> Unit,
    running: Boolean,
) {
    val context = LocalContext.current

    var recording by remember { mutableStateOf(false) }
    var recordSeconds by remember { mutableStateOf(0) }
    val recorder = remember { mutableStateOf<MediaRecorder?>(null) }
    val voiceFile = remember { mutableStateOf<File?>(null) }
    fun stopRecorder(): Boolean {
        val active = recorder.value ?: return true
        val stopped = runCatching { active.stop() }.isSuccess
        runCatching { active.release() }
        recorder.value = null
        recording = false
        return stopped
    }

    fun finishRecording() {
        val file = voiceFile.value
        val seconds = recordSeconds
        val stopped = stopRecorder()
        voiceFile.value = null
        if (!stopped) {
            file?.let { runCatching { it.delete() } }
            vm.connectionError = "录音结束时出错，未能生成语音文件，请重试"
            return
        }
        if (file == null || file.length() <= 0) {
            file?.let { runCatching { it.delete() } }
            vm.showToast("录音没有生成音频，请检查麦克风后重试")
            return
        }
        if (seconds < 1) {
            runCatching { file.delete() }
            vm.showToast("录音太短，请按住麦克风说久一点")
            return
        }
        // Reading the note and Base64-encoding it is the same work the file picker moved off this
        // thread, and it used to run on the finger that had just released the microphone button.
        vm.stageVoiceNote(context, file) { onSend() }
    }

    fun startRecording() {
        if (recording) return
        val active = MediaRecorder()
        runCatching {
            val dir = File(context.cacheDir, "voice").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, "voice-${System.currentTimeMillis()}.m4a")
            active.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioEncodingBitRate(64_000)
                setAudioSamplingRate(44_100)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder.value = active
            voiceFile.value = file
            recording = true
        }.onFailure {
            // prepare()/start() can fail (mic busy); release the half-built recorder now.
            runCatching { active.reset() }
            runCatching { active.release() }
            stopRecorder()
            vm.connectionError = "无法开始录音：${it.message}"
        }
    }

    val audioPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else vm.connectionError = "需要麦克风权限才能发送语音"
    }

    fun onMicClick() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) startRecording() else audioPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    LaunchedEffect(recording) {
        if (!recording) {
            recordSeconds = 0
            return@LaunchedEffect
        }
        val startedAt = System.currentTimeMillis()
        while (true) {
            val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
            recordSeconds = elapsed
            if (elapsed >= MAX_VOICE_SECONDS) {
                finishRecording()
                break
            }
            delay(200)
        }
    }

    // Leaving the chat mid-recording must not keep the mic open.
    DisposableEffect(Unit) {
        onDispose {
            recorder.value?.let {
                runCatching { it.stop() }
                it.release()
            }
            recorder.value = null
        }
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) stage(context, vm, uri)
    }
    val videoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) stage(context, vm, uri)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) stage(context, vm, uri)
    }
    var attachMenu by remember { mutableStateOf(false) }
    var enginePicker by remember { mutableStateOf(false) }
    LaunchedEffect(enginePicker) {
        if (enginePicker) {
            vm.refreshAgentsQuietly()
            if (vm.oneOffEngine == null) vm.refreshModels()
        }
    }
    // A bare `/engine` or `/model!` typed into the box asks for this picker
    LaunchedEffect(vm.pinPickerRequested) {
        if (vm.pinPickerRequested) {
            vm.clearPinPickerRequest()
            enginePicker = true
        }
    }
    val cameraTarget = remember { mutableStateOf<Uri?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(CapturePhoto()) { ok ->
        val uri = cameraTarget.value
        cameraTarget.value = null
        if (ok && uri != null) stage(context, vm, uri)
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCameraShot(cameraTarget, cameraLauncher, context, vm)
        else vm.connectionError = "需要相机权限才能拍照"
    }
    fun takePhoto() {
        // The manifest declares CAMERA for the pairing scanner, and an app that declares it does
        // not get a camera on loan: ACTION_IMAGE_CAPTURE comes back refused, which read as "the
        // camera is broken" on a fresh install until the user happened to scan a QR once.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            cameraPermission.launch(Manifest.permission.CAMERA)
        } else {
            launchCameraShot(cameraTarget, cameraLauncher, context, vm)
        }
    }

    val commands = listOf(
        SlashCommand("/new", "新建会话，清空上下文") { vm.newChat() },
        SlashCommand("/stop", "停止当前任务") { vm.stop() },
        SlashCommand("/retry", "重新发送上一条任务") { vm.retryLastTask() },
        SlashCommand("/queue", "查看任务队列") { vm.navigate(Screen.Queue) },
        SlashCommand("/history", "查看任务历史") { vm.navigate(Screen.History) },
        SlashCommand("/reminders", "查看提醒") { vm.navigate(Screen.Reminders) },
        SlashCommand("/schedule", "查看定时任务") { vm.navigate(Screen.Schedules) },
        SlashCommand("/agents", "引擎管理") { vm.navigate(Screen.Agents) },
        SlashCommand("/model", "模型与会话设置") { vm.navigate(Screen.Session) },
        SlashCommand("/dir", "工作目录与会话设置") { vm.navigate(Screen.Session) },
        SlashCommand("/status", "运行状态与用量") { vm.navigate(Screen.Status) },
        SlashCommand("/usage", "用量统计") { vm.navigate(Screen.Status) },
        SlashCommand("/cc", "cc-switch 控制台") { vm.navigate(Screen.Cc) },
        SlashCommand("/env", "配置项") { vm.navigate(Screen.Config) },
        SlashCommand("/proxy", "网络代理") { vm.navigate(Screen.Proxy) },
        SlashCommand("/access", "访问白名单") { vm.navigate(Screen.Access) },
        SlashCommand("/ops", "运维中心") { vm.navigate(Screen.Ops) },
        SlashCommand("/alias", "管理快捷指令") { vm.navigate(Screen.Aliases) },
        SlashCommand("/help", "帮助") { vm.navigate(Screen.Help) },
        // App-only pins: they affect the next message, not the session
        SlashCommand("/engine", "本条消息交给另一个引擎") { enginePicker = true },
        SlashCommand("/model!", "本条消息换一个模型") { enginePicker = true },
    )
    // Commands the bot answers that have no local button still belong in the palette,
    // so the App shows the same "/" surface as Telegram's menu
    val serverCommands = vm.botCommands
        .filter { item -> commands.none { command -> command.name.equals("/" + item.command, ignoreCase = true) } }
        .map { item ->
            SlashCommand("/" + item.command, item.description) { vm.runSlash("/" + item.command) }
        }
    // Stored shortcuts appear after builtins; a builtin always wins on a name clash.
    val aliasCommands = vm.aliases
        .filter { alias ->
            (commands + serverCommands).none { it.name.equals("/${alias.name}", ignoreCase = true) }
        }
        .map { alias ->
            SlashCommand(
                "/${alias.name}",
                "快捷指令 · ${alias.expansion.lineSequence().first().take(30)}",
            ) { onSendText("/${alias.name}") }
        }
    val typed = draft.trim()
    // Show the palette only while typing the command word itself, not its arguments.
    val typingSlash = draft.startsWith("/") && !typed.contains(' ')
    val suggestions = if (typingSlash) {
        (commands + serverCommands + aliasCommands).filter { it.name.startsWith(typed, ignoreCase = true) }
    } else {
        emptyList()
    }
    val exact = (commands + serverCommands).firstOrNull { it.name.equals(typed, ignoreCase = true) }
    val exactAlias = aliasCommands.firstOrNull { it.name.equals(typed, ignoreCase = true) }
    fun runCommand(command: SlashCommand) {
        onDraftChange("")
        command.run()
    }
    val canSend = exact != null || exactAlias != null || vm.pendingAttachments.isNotEmpty() ||
        (suggestions.isEmpty() && draft.isNotBlank())

    // Their lists live server-side; refresh when the palette opens so new shortcuts show up.
    LaunchedEffect(typingSlash) {
        if (typingSlash) vm.refreshPalette()
    }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column {
            if (suggestions.isNotEmpty()) {
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = MaterialTheme.shapes.medium,
                    border = androidx.compose.foundation.BorderStroke(1.dp, Border.copy(alpha = 0.8f)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp)
                        .heightIn(max = 260.dp),
                ) {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        Text(
                            "命令",
                            style = MaterialTheme.typography.labelSmall,
                            color = TextSecondary,
                            modifier = Modifier.padding(start = 14.dp, top = 10.dp, bottom = 2.dp),
                        )
                        suggestions.forEach { command ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { runCommand(command) }
                                    .padding(horizontal = 14.dp, vertical = 11.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    command.name,
                                    color = MaterialTheme.colorScheme.primary,
                                    style = MaterialTheme.typography.labelLarge,
                                )
                                Text(
                                    command.desc,
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.labelMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 12.dp),
                                )
                            }
                        }
                    }
                }
            }
            val pinnedEngine = vm.oneOffEngineLabel
            val pinnedModel = vm.oneOffModelLabel
            val overrideLabel = when {
                pinnedEngine != null -> pinnedModel?.let { model -> "$pinnedEngine / $model" } ?: pinnedEngine
                pinnedModel != null -> "默认引擎 / $pinnedModel"
                else -> null
            }
            val composerFocus = remember { MutableInteractionSource() }
            val composerFocused by composerFocus.collectIsFocusedAsState()
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(24.dp),
                border = BorderStroke(
                    1.dp,
                    if (composerFocused) MaterialTheme.colorScheme.primary.copy(alpha = 0.42f)
                    else Border.copy(alpha = 0.72f),
                ),
                shadowElevation = 8.dp,
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .padding(start = 12.dp, top = 6.dp, end = 12.dp, bottom = 10.dp),
            ) {
                Column {
                    if (recording) {
                        ComposerNotice(
                            icon = Icons.Filled.FiberManualRecord,
                            tint = MaterialTheme.colorScheme.error,
                            text = "正在录音 %d:%02d · 最长 ${MAX_VOICE_SECONDS / 60} 分钟".format(
                                recordSeconds / 60,
                                recordSeconds % 60,
                            ),
                        )
                    }
                    if (overrideLabel != null) {
                        ComposerNotice(
                            icon = Icons.Filled.Tune,
                            tint = MaterialTheme.colorScheme.primary,
                            text = "本条交给「$overrideLabel」，仅生效一次",
                            onClear = vm::clearOneOffPin,
                        )
                    }

                    BasicTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        enabled = !recording,
                        interactionSource = composerFocus,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 54.dp)
                            .padding(horizontal = 18.dp, vertical = 14.dp),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 6,
                        decorationBox = { inner ->
                            Box(contentAlignment = Alignment.TopStart) {
                                if (draft.isEmpty()) {
                                    Text(
                                        if (recording) "正在录音，完成后会作为语音发送" else "问点什么，或输入 / 命令",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = TextSecondary.copy(alpha = 0.78f),
                                    )
                                }
                                inner()
                            }
                        },
                    )

                    HorizontalDivider(color = Border.copy(alpha = 0.48f))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box {
                            ComposerIconButton(
                                icon = Icons.Filled.AttachFile,
                                label = "添加附件",
                                enabled = !recording,
                                onClick = { attachMenu = true },
                            )
                            DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text("拍照") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                                    },
                                    onClick = {
                                        attachMenu = false
                                        takePhoto()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("相册") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Image, contentDescription = null, modifier = Modifier.size(18.dp))
                                    },
                                    onClick = {
                                        attachMenu = false
                                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("视频") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Movie, contentDescription = null, modifier = Modifier.size(18.dp))
                                    },
                                    onClick = {
                                        attachMenu = false
                                        videoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("文件") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Description, contentDescription = null, modifier = Modifier.size(18.dp))
                                    },
                                    onClick = {
                                        attachMenu = false
                                        filePicker.launch(arrayOf("*/*"))
                                    },
                                )
                            }
                        }
                        ComposerIconButton(
                            icon = Icons.Filled.Tune,
                            label = "本条指定引擎",
                            selected = vm.oneOffEngine != null,
                            enabled = !recording,
                            onClick = { enginePicker = true },
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        if (running && !recording) {
                            ComposerActionButton(
                                icon = Icons.Filled.Stop,
                                label = "停止当前任务",
                                background = MaterialTheme.colorScheme.error.copy(alpha = 0.14f),
                                content = MaterialTheme.colorScheme.error,
                                onClick = vm::stop,
                            )
                        }
                        Spacer(modifier = Modifier.width(6.dp))
                        when {
                            recording -> ComposerActionButton(
                                icon = Icons.Filled.Stop,
                                label = "停止录音并发送",
                                background = MaterialTheme.colorScheme.error,
                                content = MaterialTheme.colorScheme.onError,
                                onClick = { finishRecording() },
                            )
                            else -> {
                                val voiceMode = draft.isBlank() && vm.pendingAttachments.isEmpty()
                                ComposerActionButton(
                                    icon = if (voiceMode) Icons.Filled.Mic else Icons.Filled.ArrowUpward,
                                    label = if (voiceMode) "发送语音消息" else "发送",
                                    background = if (voiceMode || !canSend) MaterialTheme.colorScheme.surfaceContainerHigh
                                    else MaterialTheme.colorScheme.primary,
                                    content = if (voiceMode || !canSend) TextSecondary
                                    else MaterialTheme.colorScheme.onPrimary,
                                    enabled = voiceMode || canSend,
                                    onClick = {
                                        if (voiceMode) {
                                            onMicClick()
                                        } else if (exact != null) {
                                            runCommand(exact)
                                        } else {
                                            onSend()
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }
            if (enginePicker) {
                val defaultEngine = vm.session?.engine
                val defaultLabel = vm.session?.engineLabel ?: defaultEngine ?: "默认"
                AlertDialog(
                    onDismissRequest = { enginePicker = false },
                    title = { Text("本条消息交给哪个引擎？") },
                    text = {
                        Column(
                            modifier = Modifier
                                .heightIn(max = 380.dp)
                                .verticalScroll(rememberScrollState()),
                        ) {
                            Text(
                                "只影响这一条消息，会话默认引擎和 Telegram 端都不变。",
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            EngineOptionRow(
                                label = "跟随默认（$defaultLabel）",
                                detail = "会话当前设置",
                                selected = vm.oneOffEngine == null,
                            ) {
                                vm.updateOneOffEngine(null)
                                enginePicker = false
                            }
                            if (vm.agents.isEmpty()) {
                                Text(
                                    "正在加载引擎列表…",
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.padding(vertical = 8.dp),
                                )
                            }
                            vm.agents.filter { it.installed }.forEach { agent ->
                                EngineOptionRow(
                                    label = agent.label,
                                    detail = if (agent.id == defaultEngine) "会话默认" else agent.desc,
                                    selected = vm.oneOffEngine != null && vm.oneOffEngine == agent.id,
                                ) {
                                    vm.updateOneOffEngine(agent.id)
                                }
                            }
                            val modelEngine = vm.oneOffModelEngine
                            Text(
                                "模型（只影响这一条）",
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
                            )
                            EngineOptionRow(
                                label = "跟随引擎配置",
                                detail = "不指定模型，由该引擎自行决定",
                                selected = vm.oneOffModel == null,
                            ) {
                                vm.updateOneOffModel(null)
                            }
                            val modelsError = vm.pinPickerModelsError
                            if (modelsError != null) {
                                Text(
                                    modelsError,
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.padding(vertical = 6.dp),
                                )
                                QuietButton(
                                    text = "重试加载模型",
                                    onClick = {
                                        if (vm.oneOffEngine == null) vm.refreshModels()
                                        else vm.reloadOneOffModels()
                                    },
                                )
                            } else if (vm.pinPickerModels.isEmpty()) {
                                Text(
                                    if (vm.pinPickerModelsLoading) {
                                        "正在读取模型…"
                                    } else vm.pinPickerModelHint?.let {
                                        "该引擎不列出可选模型，可在聊天里发送 /model! <模型ID>（提示：$it）"
                                    } ?: if (modelEngine == null) {
                                        "尚无可用的会话引擎；请先连接并在「会话设置」中选择引擎。"
                                    } else {
                                        "该引擎不列出可选模型，留空即由该引擎自身配置决定。"
                                    },
                                    color = TextSecondary,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.padding(vertical = 6.dp),
                                )
                            }
                            vm.pinPickerModels.forEach { option ->
                                EngineOptionRow(
                                    label = option.label,
                                    detail = option.desc ?: option.detail,
                                    selected = vm.oneOffModel == option.value,
                                ) {
                                    vm.updateOneOffModel(option.value)
                                }
                            }
                        }
                    },
                    confirmButton = {
                        QuietButton(text = "完成", onClick = { enginePicker = false })
                    },
                )
            }
        }
    }
}

@Composable
private fun EngineOptionRow(label: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                if (selected) "✓ $label" else label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.bodyMedium, color = TextSecondary, maxLines = 1)
            }
        }
    }
}

/** A single-line status/override notice inside the composer, keeping the input surface compact. */
@Composable
private fun ComposerNotice(
    icon: ImageVector,
    tint: Color,
    text: String,
    onClear: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = if (onClear == null) 16.dp else 6.dp, top = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        Text(
            text,
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = 7.dp),
        )
        if (onClear != null) {
            IconButton(onClick = onClear, modifier = Modifier.size(30.dp)) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = "取消本条引擎指定",
                    tint = TextSecondary,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

@Composable
private fun ComposerIconButton(
    icon: ImageVector,
    label: String,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.size(36.dp),
            shape = CircleShape,
            color = if (selected) SurfaceHigh.copy(alpha = 0.8f) else Color.Transparent,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    icon,
                    contentDescription = label,
                    tint = when {
                        !enabled -> TextSecondary.copy(alpha = 0.42f)
                        selected -> MaterialTheme.colorScheme.onSurface
                        else -> TextSecondary
                    },
                    modifier = Modifier.size(19.dp),
                )
            }
        }
    }
}

@Composable
private fun ComposerActionButton(
    icon: ImageVector,
    label: String,
    background: Color,
    content: Color,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.size(36.dp),
            shape = CircleShape,
            color = if (enabled) background else background.copy(alpha = 0.55f),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = label, tint = content, modifier = Modifier.size(19.dp))
            }
        }
    }
}

private fun stage(context: android.content.Context, vm: AppViewModel, uri: Uri) {
    vm.stageAttachmentFrom(context, uri)
}

/** ACTION_IMAGE_CAPTURE with URI grants; a FileProvider output needs read/write flags. */
private class CapturePhoto : ActivityResultContract<Uri, Boolean>() {
    override fun createIntent(context: Context, input: Uri): Intent =
        Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, input)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)

    override fun parseResult(resultCode: Int, intent: Intent?): Boolean = resultCode == Activity.RESULT_OK
}
