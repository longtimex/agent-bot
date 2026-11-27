package com.agentbot.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentbot.app.data.ModelEntry
import com.agentbot.app.ui.theme.AppRadius
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextPrimary
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * Engine and model switching in one dialog: engines first (one tap switches),
 * then the current engine's models.
 */
@Composable
fun PickerDialog(title: String, onDismiss: () -> Unit, vm: AppViewModel) {
    LaunchedEffect(Unit) {
        vm.refreshAgents()
        vm.refreshModels(force = true)
    }
    AppDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭") }
        },
        title = { Text(title, style = MaterialTheme.typography.titleLarge) },
        text = {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                item {
                    SectionLabel("引擎", modifier = Modifier.padding(bottom = 4.dp))
                }
                // Current first, then what can actually run, uninstalled last: the old order put a
                // missing CLI among the usable ones, and switching to it made every message fail
                val ordered = vm.agents.sortedWith(
                    compareByDescending<com.agentbot.app.data.AgentInfo> { it.id == vm.session?.engine }
                        .thenByDescending { it.installed },
                )
                items(ordered, key = { "agent:" + it.id }) { agent ->
                    val current = agent.id == vm.session?.engine
                    // What a switch means for the conversation, said before the tap rather than after
                    val context = if (agent.stateless) "每次新进程，Bot 会带上最近几轮对话" else "保留上下文"
                    PickerRow(
                        primary = agent.label,
                        secondary = when {
                            !agent.installed -> "未安装：切换后发消息会失败，请先到引擎管理安装"
                            current -> "当前引擎 · $context"
                            else -> context
                        },
                        selected = current,
                        enabled = agent.installed || current,
                        onClick = {
                            if (!current) vm.switchAgent(agent.id)
                        },
                    )
                }
                item {
                    Text(
                        "模型".uppercase(),
                        color = TextTertiary,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
                    )
                }
                items(vm.models, key = { "model:" + it.value }) { model ->
                    PickerRow(
                        primary = model.label,
                        secondary = model.desc ?: model.detail,
                        // The server reports the session's model by label (and OpenCode also by
                        // provider/model), so comparing the value alone never marked the current one
                        selected = vm.session?.let { s ->
                            s.model != null && (model.value == s.model || model.label == s.model) ||
                                (s.modelRef != null && model.providerID == s.modelRef.providerID && model.modelID == s.modelRef.modelID)
                        } == true,
                        onClick = {
                            vm.setModel(model)
                        },
                    )
                }
                if (vm.models.isEmpty()) {
                    item {
                        // The server's live probe names missing CLI, account, or failure cause.
                        Text(
                            vm.modelEmptyText,
                            color = TextTertiary,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                    }
                }
                item {
                    PickerRow(
                        primary = "清除本会话模型选择",
                        secondary = "之后由引擎自身配置决定",
                        selected = false,
                        onClick = {
                            vm.resetModel()
                            onDismiss()
                        },
                    )
                }
            }
        },
    )
}

@Composable
private fun PickerRow(
    primary: String,
    secondary: String?,
    selected: Boolean,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(AppRadius.md))
            .clickable(enabled = enabled, onClick = onClick)
            .then(if (enabled) Modifier else Modifier.alpha(0.5f)),
        shape = RoundedCornerShape(AppRadius.md),
        color = if (selected) SurfaceHigh.copy(alpha = 0.55f) else androidx.compose.ui.graphics.Color.Transparent,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            SelectionMark(selected)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    primary,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (selected) TextPrimary else MaterialTheme.colorScheme.onSurface,
                )
                if (secondary != null) {
                    Text(
                        secondary,
                        style = MaterialTheme.typography.labelSmall,
                        color = TextTertiary,
                        maxLines = 2,
                    )
                }
            }
        }
    }
}

/** Simple centered text prompt, shared by reminders, schedules and session settings. */
@Composable
fun TextPromptDialog(
    title: String,
    hint: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    error: String? = null,
    initial: String = "",
    confirmLabel: String = "创建",
    placeholder: String = "例如：30m 喝水",
    maxLines: Int = 3,
    allowBlank: Boolean = false,
) {
    var value by remember { mutableStateOf(initial) }
    // A Dialog cannot rely on the Activity's adjustResize for its IME inset. Constrain the whole
    // surface above the keyboard; otherwise its bottom action row is still covered.
    DialogShell(onDismiss = onDismiss) {
        TextPromptContent(
            title = title,
            hint = hint,
            error = error,
            value = value,
            onValueChange = { value = it },
            placeholder = placeholder,
            maxLines = maxLines,
            confirmLabel = confirmLabel,
            allowBlank = allowBlank,
            onDismiss = onDismiss,
            onConfirm = { if (allowBlank || value.isNotBlank()) onConfirm(value) },
        )
    }
}

@Composable
private fun DialogShell(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    // A Dialog owns a separate Window, so the Activity's adjustResize does not reach it.
    // Keep the window full size and inset the content: the surface can then shrink to the
    // remaining height instead of being measured at 82% and clipped from the bottom.
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .imePadding()
                .padding(horizontal = 20.dp, vertical = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth().heightIn(max = 640.dp),
                shape = RoundedCornerShape(AppRadius.xl),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                // Same surface/border pair as AppDialog, so the prompt box and the confirmation
                // box that follows it read as one family.
                border = BorderStroke(1.dp, Border.copy(alpha = 0.72f)),
            ) {
                Column(modifier = Modifier.fillMaxWidth(), content = content)
            }
        }
    }
}

@Composable
private fun TextPromptContent(
    title: String,
    hint: String,
    error: String?,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    maxLines: Int,
    confirmLabel: String,
    allowBlank: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    var reasonExpanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        // Measure the actions first and give the body only what remains. The old fixed 340dp
        // body could still overflow a short, keyboard-constrained dialog and clip the actions.
        // Keep the divider and actions inside this root so they are siblings of the weighted
        // body; leaving them outside let the body consume the whole height first.
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(hint, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
        }
        // Keep the rejection beside the draft: the body above may already be scrolled to its
        // bottom when the IME opens, and a reason left inside it would be clipped just above
        // the field. Collapsed to two lines by default so a server's long key list cannot
        // crowd the title out of this short, keyboard-constrained dialog.
        error?.let {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { reasonExpanded = !reasonExpanded }
                    .padding(horizontal = 24.dp)
                    .padding(bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = if (reasonExpanded) Int.MAX_VALUE else 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (it.length > 60) {
                    Text(
                        if (reasonExpanded) "收起" else "展开",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
        // The field is outside both scrolling bodies, so it remains visible even with a long
        // server reason above it.
        AppTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = placeholder,
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp),
            maxLines = maxLines,
        )
        HorizontalDivider(color = Border.copy(alpha = 0.5f))
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = onDismiss) { Text("取消") }
            TextButton(onClick = onConfirm, enabled = allowBlank || value.isNotBlank()) { Text(confirmLabel) }
        }
    }
}

/**
 * One value out of a server-provided list (cc-switch templates, API formats).
 * [allowNone] adds a "不指定" row so a field can be cleared again.
 */
@Composable
fun OptionPickerDialog(
    title: String,
    options: List<String>,
    selected: String?,
    onDismiss: () -> Unit,
    onSelect: (String?) -> Unit,
    allowNone: Boolean = false,
) {
    AppDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        title = { Text(title, style = MaterialTheme.typography.titleLarge) },
        text = {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                if (options.isEmpty()) {
                    item {
                        Text("服务器未返回可选项", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                items(options, key = { it }) { option ->
                    PickerRow(
                        primary = option,
                        secondary = null,
                        selected = option == selected,
                        onClick = {
                            onSelect(option)
                            onDismiss()
                        },
                    )
                }
                if (allowNone) {
                    item {
                        PickerRow(
                            primary = "不指定",
                            secondary = "清除该字段",
                            selected = selected == null,
                            onClick = {
                                onSelect(null)
                                onDismiss()
                            },
                        )
                    }
                }
            }
        },
    )
}

/** A stateless detail row used by the list screens. */
data class ListRow(
    val title: String,
    val subtitle: String? = null,
    val tag: String? = null,
)
