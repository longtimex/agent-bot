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
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.agentbot.app.data.LocalStore
import com.agentbot.app.data.PendingAttachment
import com.agentbot.app.data.TaskMedia
import com.agentbot.app.ui.theme.BubbleUser
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.TextSecondary
import java.io.File
import java.util.Base64
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
            vm.setDraft(if (draft.isBlank()) shared else draft.trimEnd() + "\n" + shared)
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
            vm.setDraft("")
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

        if (vm.messages.isEmpty()) EmptyChat(sessionLabel = vm.session?.engineLabel)

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
                onRetry = {
                    vm.connectionError = null
                    vm.retryLastFailed()
                },
            )

            AttachmentStrip(
                attachments = vm.pendingAttachments,
                onRemove = { vm.removeAttachment(it) },
            )

            ChatInputBar(
                vm = vm,
                draft = draft,
                onDraftChange = vm::setDraft,
                onSend = { submit(draft) },
                onSendText = ::submit,
                running = running,
            )
        }
    }
}

@Composable
private fun ChatTopBar(vm: AppViewModel, onOpenDrawer: () -> Unit, searching: Boolean, onToggleSearch: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onOpenDrawer) {
                Icon(
                    Icons.Filled.Menu,
                    contentDescription = "菜单",
                    tint = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.size(20.dp),
                )
            }
            ModelChip(vm)
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
            ConnectionDot(
                connected = vm.session != null && vm.connectionError == null,
                onNavigate = { vm.navigate(Screen.Settings) },
            )
            IconButton(onClick = onToggleSearch) {
                Icon(
                    if (searching) Icons.Filled.Close else Icons.Filled.Search,
                    contentDescription = if (searching) "关闭搜索" else "搜索",
                    tint = TextSecondary,
                    modifier = Modifier.size(20.dp),
                )
            }
            IconButton(onClick = { vm.navigate(Screen.Session) }) {
                Icon(
                    Icons.Filled.Tune,
                    contentDescription = "会话设置",
                    tint = TextSecondary,
                    modifier = Modifier.size(20.dp),
                )
            }
            IconButton(onClick = { vm.navigate(Screen.Queue) }) {
                Icon(
                    Icons.Filled.List,
                    contentDescription = "任务队列",
                    tint = TextSecondary,
                    modifier = Modifier.size(20.dp),
                )
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
                .padding(start = 12.dp, end = 4.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus),
                placeholder = { Text("搜索当前会话…", color = TextSecondary) },
                leadingIcon = {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { onQueryChange("") }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Filled.Close, contentDescription = "清空", tint = TextSecondary, modifier = Modifier.size(16.dp))
                        }
                    }
                },
                singleLine = true,
                shape = RoundedCornerShape(24.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MaterialTheme.colorScheme.surfaceVariant,
                    unfocusedBorderColor = MaterialTheme.colorScheme.surfaceVariant,
                    focusedContainerColor = MaterialTheme.colorScheme.surface,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                ),
            )
            TextButton(onClick = onClose) { Text("取消") }
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
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
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
    AssistChip(
        onClick = { showPicker = true },
        label = { Text(label, maxLines = 1) },
        modifier = Modifier.widthIn(max = 260.dp),
    )
    if (showPicker) {
        PickerDialog(title = "切换引擎 / 模型", onDismiss = { showPicker = false }, vm = vm)
    }
}

/** Green/red status dot; tapping it opens the settings page when things are broken. */
@Composable
private fun ConnectionDot(connected: Boolean, onNavigate: () -> Unit) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .clickable(onClick = onNavigate),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(if (connected) OkGreen else MaterialTheme.colorScheme.error),
        )
    }
}

@Composable
private fun EmptyChat(sessionLabel: String?) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 72.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("⚡", style = MaterialTheme.typography.displayMedium)
        Text("Agent Bot", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
        Text(
            sessionLabel?.let { "当前引擎：$it" } ?: "连接服务器后即可开始对话",
            style = MaterialTheme.typography.bodyMedium,
            color = TextSecondary,
            modifier = Modifier.padding(top = 6.dp),
        )
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
                    .widthIn(max = 300.dp)
                    .copyOnLongPress(clipboard, context, message.text)
                    .clip(RoundedCornerShape(18.dp, 4.dp, 18.dp, 18.dp))
                    .background(BubbleUser)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
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
                            fontSize = 10.sp,
                            color = TextSecondary,
                            modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
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
    Column(modifier = Modifier.widthIn(max = 340.dp)) {
        SelectionContainer {
            Column {
                when {
                    status == "queued" || status == "running" -> RunningLine(message)
                    status == "failed" -> {
                        Text(
                            message.text.ifEmpty { "任务失败" },
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    status == "cancelled" -> Text("已停止", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                    else -> MarkdownText(message.text)
                }
            }
        }
        if (onRetry != null && (status == "failed" || status == "cancelled")) {
            TextButton(onClick = onRetry) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(if (status == "cancelled") "重新执行" else "重试", modifier = Modifier.padding(start = 4.dp))
            }
        }
        if (message.media.isNotEmpty() && message.taskId != null) {
            AssistantMedia(vm, message.taskId, message.media)
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            Text(
                AppViewModel.formatTime(message.at),
                color = TextSecondary.copy(alpha = 0.6f),
                style = MaterialTheme.typography.labelMedium,
            )
            if (message.text.isNotBlank()) {
                Row(
                    modifier = Modifier
                        .padding(start = 6.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .clickable {
                            clipboard.setText(AnnotatedString(message.text))
                            copied = true
                        }
                        .padding(horizontal = 4.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                        contentDescription = "复制回复",
                        tint = if (copied) MaterialTheme.colorScheme.primary else TextSecondary.copy(alpha = 0.6f),
                        modifier = Modifier.size(12.dp),
                    )
                    Text(
                        if (copied) "已复制" else "复制",
                        color = if (copied) MaterialTheme.colorScheme.primary else TextSecondary.copy(alpha = 0.6f),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(start = 3.dp),
                    )
                }
            }
        }
    }
}

/** "● 思考中… · 已运行 12 秒" — the progress line ticks locally between polls. */
@Composable
private fun RunningLine(message: ChatMessage) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(message.startedAt) {
        while (true) {
            now = System.currentTimeMillis()
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
            if (item.kind == "image") ImageMedia(vm, taskId, item) else MediaCard(vm, taskId, item)
        }
    }
}

@Composable
private fun ImageMedia(vm: AppViewModel, taskId: String, media: TaskMedia) {
    val key = "$taskId/${media.index}"
    val bitmap = vm.mediaImages[key]
    val failed = key in vm.mediaErrors
    var viewing by remember { mutableStateOf(false) }
    LaunchedEffect(key) { vm.loadMediaImage(taskId, media) }
    if (bitmap != null) {
        val image = bitmap.asImageBitmap()
        Image(
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
                TextButton(onClick = { vm.loadMediaImage(taskId, media, retry = true) }) {
                    Text("图片加载失败，重试")
                }
            } else {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun MediaCard(vm: AppViewModel, taskId: String, media: TaskMedia) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .widthIn(max = 300.dp)
            .fillMaxWidth()
            .clickable { vm.openMedia(taskId, media) },
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
            IconButton(onClick = { vm.openMedia(taskId, media) }, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Filled.OpenInNew,
                    contentDescription = "打开",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

private fun mediaIcon(kind: String) = when (kind) {
    "voice" -> Icons.Filled.GraphicEq
    "video" -> Icons.Filled.Movie
    "image" -> Icons.Filled.Image
    else -> Icons.Filled.Description
}

@Composable
private fun ErrorBanner(message: String?, onRetry: () -> Unit, onDismiss: () -> Unit) {
    if (message == null) return
    Surface(color = MaterialTheme.colorScheme.error.copy(alpha = 0.15f)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
                maxLines = 3,
            )
            TextButton(onClick = onRetry) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("重试", modifier = Modifier.padding(start = 4.dp))
            }
            IconButton(onClick = onDismiss, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "关闭", modifier = Modifier.size(14.dp))
            }
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
    // Hash key: comparing multi-MB base64 strings on every keystroke would be wasteful.
    val thumb by produceState<ImageBitmap?>(initialValue = null, key1 = att.base64.hashCode()) {
        value = if (isImage) withContext(Dispatchers.IO) { decodeThumbnail(att.base64) } else null
    }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
        ) {
            val preview = thumb
            when {
                preview != null -> Image(
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
                else -> Icon(
                    Icons.Filled.AttachFile,
                    contentDescription = null,
                    tint = TextSecondary,
                    modifier = Modifier.size(18.dp),
                )
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
                    formatSize(att.sizeBytes),
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

/** Downsampled preview decoded off the main thread; the full-size bytes never reach the UI. */
private fun decodeThumbnail(base64: String): ImageBitmap? = runCatching {
    val bytes = Base64.getDecoder().decode(base64)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 160 && bounds.outHeight / (sample * 2) >= 160) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}.getOrNull()

/** Keeps a voice note well inside the server's 15MB attachment budget. */
private const val MAX_VOICE_SECONDS = 120

private fun formatSize(bytes: Int): String =
    if (bytes >= 1024 * 1024) "${bytes / 1024 / 1024}MB" else "${(bytes + 1023) / 1024}KB"

/** A slash command that maps a Telegram-style chat command to a local app action. */
private data class SlashCommand(val name: String, val desc: String, val run: () -> Unit)

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

    fun stopRecorder() {
        recorder.value?.let { active ->
            runCatching { active.stop() }
            active.release()
        }
        recorder.value = null
        recording = false
    }

    fun finishRecording() {
        val file = voiceFile.value
        val seconds = recordSeconds
        stopRecorder()
        voiceFile.value = null
        var staged = false
        if (file != null && file.length() > 0) {
            if (seconds < 1) {
                vm.showToast("录音太短，请按住麦克风说久一点")
            } else {
                runCatching {
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                    val stagedAttachment = LocalStore.read(context, uri)
                    // Some resolvers cannot name .m4a; keep the server's audio path intact.
                    staged = vm.stageAttachment(
                        if (stagedAttachment.mime.startsWith("audio/")) stagedAttachment
                        else stagedAttachment.copy(mime = "audio/mp4"),
                    )
                }.onFailure { vm.connectionError = "语音发送失败：${it.message}" }
            }
        }
        runCatching { File(context.cacheDir, "voice").listFiles()?.forEach { it.delete() } }
        // Telegram sends a voice note as soon as recording stops, so do the same here.
        if (staged) onSend()
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
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) stage(context, vm, uri)
    }
    var attachMenu by remember { mutableStateOf(false) }
    var enginePicker by remember { mutableStateOf(false) }
    LaunchedEffect(enginePicker) {
        if (enginePicker) vm.refreshAgentsQuietly()
    }
    val cameraTarget = remember { mutableStateOf<Uri?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(CapturePhoto()) { ok ->
        val uri = cameraTarget.value
        cameraTarget.value = null
        if (ok && uri != null) stage(context, vm, uri)
    }
    fun takePhoto() {
        runCatching {
            val dir = File(context.cacheDir, "camera").apply { mkdirs() }
            // Only one shot is pending at a time and its bytes are staged in memory.
            dir.listFiles()?.forEach { it.delete() }
            val file = File.createTempFile("shot-", ".jpg", dir)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            cameraTarget.value = uri
            cameraLauncher.launch(uri)
        }.onFailure {
            cameraTarget.value = null
            vm.connectionError = "无法启动相机：${it.message}"
        }
    }

    val commands = listOf(
        SlashCommand("/new", "新建会话，清空上下文") { vm.newChat() },
        SlashCommand("/stop", "停止当前任务") { vm.stop() },
        SlashCommand("/retry", "重新发送上一条任务") { vm.retryLastFailed() },
        SlashCommand("/queue", "查看任务队列") { vm.navigate(Screen.Queue) },
        SlashCommand("/history", "查看任务历史") { vm.navigate(Screen.History) },
        SlashCommand("/reminders", "查看提醒") { vm.navigate(Screen.Reminders) },
        SlashCommand("/schedule", "查看定时任务") { vm.navigate(Screen.Schedules) },
        SlashCommand("/agents", "引擎管理") { vm.navigate(Screen.Agents) },
        SlashCommand("/model", "模型与会话设置") { vm.navigate(Screen.Session) },
        SlashCommand("/dir", "工作目录与模型默认值") { vm.navigate(Screen.Session) },
        SlashCommand("/status", "运行状态与用量") { vm.navigate(Screen.Status) },
        SlashCommand("/usage", "用量统计") { vm.navigate(Screen.Status) },
        SlashCommand("/cc", "cc-switch 控制台") { vm.navigate(Screen.Cc) },
        SlashCommand("/env", "配置项") { vm.navigate(Screen.Config) },
        SlashCommand("/proxy", "网络代理") { vm.navigate(Screen.Proxy) },
        SlashCommand("/access", "访问白名单") { vm.navigate(Screen.Access) },
        SlashCommand("/ops", "运维中心") { vm.navigate(Screen.Ops) },
        SlashCommand("/alias", "快捷指令") { vm.navigate(Screen.Aliases) },
        SlashCommand("/help", "帮助") { vm.navigate(Screen.Help) },
    )
    val typed = draft.trim()
    // Stored shortcuts appear after builtins; a builtin always wins on a name clash.
    val aliasCommands = vm.aliases
        .filter { alias -> commands.none { it.name.equals("/${alias.name}", ignoreCase = true) } }
        .map { alias ->
            SlashCommand(
                "/${alias.name}",
                "快捷指令 · ${alias.expansion.lineSequence().first().take(30)}",
            ) { onSendText("/${alias.name}") }
        }
    // Show the palette only while typing the command word itself, not its arguments.
    val typingSlash = draft.startsWith("/") && !typed.contains(' ')
    val suggestions = if (typingSlash) {
        (commands + aliasCommands).filter { it.name.startsWith(typed, ignoreCase = true) }
    } else {
        emptyList()
    }
    val exact = commands.firstOrNull { it.name.equals(typed, ignoreCase = true) }
    val exactAlias = aliasCommands.firstOrNull { it.name.equals(typed, ignoreCase = true) }
    fun runCommand(command: SlashCommand) {
        onDraftChange("")
        command.run()
    }
    val canSend = exact != null || exactAlias != null || vm.pendingAttachments.isNotEmpty() ||
        (suggestions.isEmpty() && draft.isNotBlank())

    // Their list lives server-side; refresh when the palette opens so new shortcuts show up.
    LaunchedEffect(typingSlash) {
        if (typingSlash) vm.refreshAliasesQuietly()
    }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column {
            if (suggestions.isNotEmpty()) {
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp)
                        .heightIn(max = 260.dp),
                ) {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        suggestions.forEach { command ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { runCommand(command) }
                                    .padding(horizontal = 14.dp, vertical = 10.dp),
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
                                    modifier = Modifier.padding(start = 12.dp),
                                )
                            }
                        }
                    }
                }
            }
            val pinnedEngine = vm.oneOffEngineLabel
            val pinnedModel = vm.oneOffModelLabel
            val overrideLabel = pinnedEngine?.let { engine -> pinnedModel?.let { model -> "$engine / $model" } ?: engine }
            if (overrideLabel != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Tune,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        "本条消息交给「$overrideLabel」，发送后自动恢复默认",
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.weight(1f, fill = false).padding(start = 6.dp),
                    )
                    IconButton(onClick = { vm.setOneOffEngine(null) }, modifier = Modifier.size(28.dp)) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "取消本条引擎指定",
                            tint = TextSecondary,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            if (recording) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.FiberManualRecord,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(10.dp),
                    )
                    Text(
                        "正在录音 %d:%02d · 最长 ${MAX_VOICE_SECONDS / 60} 分钟，点 ■ 停止并发送".format(
                            recordSeconds / 60,
                            recordSeconds % 60,
                        ),
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                Box {
                    IconButton(onClick = { attachMenu = true }, enabled = !recording) {
                        Icon(Icons.Filled.AttachFile, contentDescription = "添加附件", tint = TextSecondary)
                    }
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
                IconButton(onClick = { enginePicker = true }, enabled = !recording) {
                    Icon(
                        Icons.Filled.Tune,
                        contentDescription = "本条指定引擎",
                        tint = if (vm.oneOffEngine != null) MaterialTheme.colorScheme.primary else TextSecondary,
                    )
                }
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    modifier = Modifier.weight(1f),
                    enabled = !recording,
                    placeholder = { Text("发送消息，或输入 / 执行命令…", color = TextSecondary) },
                    shape = RoundedCornerShape(24.dp),
                    maxLines = 5,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.surfaceVariant,
                        unfocusedBorderColor = MaterialTheme.colorScheme.surfaceVariant,
                        focusedContainerColor = MaterialTheme.colorScheme.surface,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    ),
                )
                if (running && !recording) {
                    IconButton(onClick = vm::stop) {
                        Icon(Icons.Filled.Stop, contentDescription = "停止", tint = MaterialTheme.colorScheme.error)
                    }
                }
                when {
                    recording -> IconButton(onClick = { finishRecording() }) {
                        Icon(
                            Icons.Filled.Stop,
                            contentDescription = "停止录音并发送",
                            tint = MaterialTheme.colorScheme.error,
                        )
                    }
                    draft.isBlank() && vm.pendingAttachments.isEmpty() -> IconButton(onClick = { onMicClick() }) {
                        Icon(Icons.Filled.Mic, contentDescription = "语音消息", tint = TextSecondary)
                    }
                    else -> IconButton(
                        onClick = {
                            if (exact != null) runCommand(exact) else onSend()
                        },
                        enabled = canSend,
                    ) {
                        Icon(
                            Icons.Filled.Send,
                            contentDescription = "发送",
                            tint = if (canSend) MaterialTheme.colorScheme.primary else TextSecondary,
                        )
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
                                vm.setOneOffEngine(null)
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
                                    detail = if (agent.id == defaultEngine) "会话默认" else agent.defaultModel ?: agent.desc,
                                    selected = vm.oneOffEngine != null && vm.oneOffEngine == agent.id,
                                ) {
                                    vm.setOneOffEngine(agent.id)
                                }
                            }
                            if (vm.oneOffEngine != null) {
                                Text(
                                    "模型（只影响这一条）",
                                    style = MaterialTheme.typography.titleSmall,
                                    modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
                                )
                                EngineOptionRow(
                                    label = "跟随引擎默认",
                                    detail = vm.agents.firstOrNull { it.id == vm.oneOffEngine }?.defaultModel,
                                    selected = vm.oneOffModel == null,
                                ) {
                                    vm.setOneOffModel(null)
                                }
                                if (vm.oneOffModels.isEmpty()) {
                                    Text(
                                        "该引擎不列出可选模型，留空即使用默认。",
                                        color = TextSecondary,
                                        style = MaterialTheme.typography.bodyMedium,
                                        modifier = Modifier.padding(vertical = 6.dp),
                                    )
                                }
                                vm.oneOffModels.forEach { option ->
                                    EngineOptionRow(
                                        label = option.label,
                                        detail = option.desc ?: option.value,
                                        selected = vm.oneOffModel == option.value,
                                    ) {
                                        vm.setOneOffModel(option.value)
                                    }
                                }
                            }
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = { enginePicker = false }) { Text("完成") }
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

private fun stage(context: android.content.Context, vm: AppViewModel, uri: Uri) {
    runCatching { LocalStore.read(context, uri) }
        .onSuccess { vm.stageAttachment(it) }
        .onFailure { vm.connectionError = "读取附件失败：${it.message}" }
}

/** ACTION_IMAGE_CAPTURE with URI grants; a FileProvider output needs read/write flags. */
private class CapturePhoto : ActivityResultContract<Uri, Boolean>() {
    override fun createIntent(context: Context, input: Uri): Intent =
        Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, input)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)

    override fun parseResult(resultCode: Int, intent: Intent?): Boolean = resultCode == Activity.RESULT_OK
}
