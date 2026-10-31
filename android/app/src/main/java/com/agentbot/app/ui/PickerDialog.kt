package com.agentbot.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ModelEntry
import com.agentbot.app.ui.theme.TextSecondary

/**
 * Engine and model switching in one dialog: engines first (one tap switches),
 * then the current engine's models.
 */
@Composable
fun PickerDialog(title: String, onDismiss: () -> Unit, vm: AppViewModel) {
    LaunchedEffect(Unit) {
        vm.refreshAgents()
        vm.refreshModels()
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭") }
        },
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                item {
                    Text("引擎", color = TextSecondary, style = MaterialTheme.typography.labelMedium)
                }
                items(vm.agents, key = { "agent:" + it.id }) { agent ->
                    PickerRow(
                        primary = agent.label,
                        secondary = when {
                            !agent.installed -> "未安装"
                            agent.id == vm.session?.engine -> "当前引擎"
                            else -> agent.desc ?: agent.defaultModel ?: agent.id
                        },
                        selected = agent.id == vm.session?.engine,
                        onClick = {
                            vm.switchAgent(agent.id)
                        },
                    )
                }
                item {
                    Text(
                        "模型",
                        color = TextSecondary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
                    )
                }
                items(vm.models, key = { "model:" + it.value }) { model ->
                    PickerRow(
                        primary = model.label,
                        secondary = model.desc ?: model.value,
                        selected = model.label == vm.session?.model,
                        onClick = {
                            vm.setModel(model)
                        },
                    )
                }
                if (vm.models.isEmpty()) {
                    item {
                        Text("该引擎没有可列出的模型", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                item {
                    PickerRow(
                        primary = "↩️ 恢复默认模型",
                        secondary = "取消本会话的模型选择",
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
private fun PickerRow(primary: String, secondary: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                if (selected) "✓ $primary" else primary,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (secondary != null) {
                Text(secondary, style = MaterialTheme.typography.bodyMedium, color = TextSecondary, maxLines = 1)
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
    initial: String = "",
    confirmLabel: String = "创建",
    placeholder: String = "例如：30m 喝水",
    maxLines: Int = 3,
) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                if (value.isNotBlank()) onConfirm(value)
            }, enabled = value.isNotBlank()) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            Column {
                Text(hint, color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    placeholder = { Text(placeholder) },
                    maxLines = maxLines,
                )
            }
        },
    )
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
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
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
                            primary = "↩️ 不指定",
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
