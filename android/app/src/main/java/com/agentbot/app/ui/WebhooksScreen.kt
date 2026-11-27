package com.agentbot.app.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.WebhookEntry
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Inbound Webhook triggers: create endpoints, copy HMAC secrets, test & toggle. */
@Composable
fun WebhooksScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val view = vm.webhooksView
    val hooks = view?.hooks ?: emptyList()
    var showCreate by remember { mutableStateOf(false) }
    var nameDraft by remember { mutableStateOf("") }
    var templateDraft by remember { mutableStateOf("分析本次事件并给出排查建议：{{payload}}") }
    var deleteTarget by remember { mutableStateOf<WebhookEntry?>(null) }
    var revealedId by remember { mutableStateOf<String?>(null) }

    fun copyText(label: String, text: String, sensitive: Boolean = false) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
        }
        clipboard.setPrimaryClip(clip)
        vm.showToast("已复制$label")
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ScreenHeader(
            title = "Webhook 触发器",
            subtitle = "接收 GitHub / Sentry / 监控事件并由 AI 处理",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    AppIconButton(
                        icon = Icons.Filled.Add,
                        contentDescription = "新建 Webhook",
                        onClick = { showCreate = true },
                    )
                    AppIconButton(
                        icon = Icons.Filled.Refresh,
                        contentDescription = "刷新 Webhook",
                        onClick = vm::refreshWebhooks,
                    )
                }
            },
        )

        PageErrorNotice(
            message = vm.webhooksActionError,
            onDismiss = { vm.webhooksActionError = null },
        )

        val loadError = vm.webhooksError
        if (loadError != null && view == null) {
            PageLoadError(
                title = "暂时无法读取 Webhook 列表",
                message = loadError,
                icon = Icons.Filled.Warning,
                onRetry = vm::refreshWebhooks,
            )
            return@Column
        }

        if (vm.webhooksBusy && view == null) LoadingBar()

        if (hooks.isEmpty() && !vm.webhooksBusy) {
            EmptyState(
                icon = Icons.Filled.Bolt,
                title = "暂无 Webhook 触发器",
                message = "点击右上角 + 创建入站地址，外部系统携带 X-Webhook-Secret 或 GitHub X-Hub-Signature-256 即可唤醒 AI 自动排查并推送结果。",
                action = {
                    PrimaryButton(text = "新建 Webhook", onClick = { showCreate = true })
                },
            )
        } else {
            hooks.forEach { hook ->
                val triggerUrl = (view?.triggerBaseUrl?.trimEnd('/') ?: "${vm.serverUrl.trimEnd('/')}/api/v1/hooks") + "/${hook.id}/trigger"
                val revealed = revealedId == hook.id
                AppCard {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(hook.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            StatusPill(
                                text = if (hook.enabled) "启用" else "暂停",
                                tone = if (hook.enabled) StatusTone.Success else StatusTone.Neutral,
                            )
                        }
                        Text(
                            triggerUrl,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = TextSecondary,
                        )
                        Text(
                            "模板：${hook.promptTemplate}",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextSecondary,
                            maxLines = 3,
                        )
                        val stat = buildString {
                            append("已触发 ${hook.triggerCount} 次")
                            hook.lastStatus?.let { append(" · 上次 $it") }
                            hook.lastTriggeredAt?.let { append(" · ${AppViewModel.formatTime(it)}") }
                        }
                        Text(stat, color = TextTertiary, style = MaterialTheme.typography.labelSmall)
                        hook.lastSummary?.takeIf { it.isNotBlank() }?.let {
                            Text("最近摘要：$it", color = TextTertiary, style = MaterialTheme.typography.labelSmall, maxLines = 2)
                        }
                        if (revealed && hook.secret.isNotBlank()) {
                            Text(
                                "Secret: ${hook.secret}",
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            QuietButton(
                                text = "复制地址",
                                modifier = Modifier.weight(1f),
                                onClick = { copyText("触发地址", triggerUrl) },
                            )
                            QuietButton(
                                text = if (revealed) "隐藏密钥" else "查看/复制密钥",
                                modifier = Modifier.weight(1f),
                                onClick = {
                                    revealedId = if (revealed) null else hook.id
                                    if (!revealed && hook.secret.isNotBlank()) {
                                        copyText("Webhook 密钥", hook.secret, sensitive = true)
                                    }
                                },
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SecondaryButton(
                                text = if (hook.enabled) "暂停" else "启用",
                                modifier = Modifier.weight(1f),
                                enabled = !vm.webhooksBusy,
                                onClick = { vm.toggleWebhook(hook.id) },
                            )
                            SecondaryButton(
                                text = "测试触发",
                                modifier = Modifier.weight(1f),
                                enabled = !vm.webhooksBusy,
                                onClick = { vm.testWebhook(hook.id) },
                            )
                            SecondaryButton(
                                text = "删除",
                                danger = true,
                                modifier = Modifier.weight(1f),
                                enabled = !vm.webhooksBusy,
                                onClick = { deleteTarget = hook },
                            )
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        AppDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("新建 Webhook 触发器") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    vm.webhooksActionError?.let { err ->
                        Text(err, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    AppTextField(
                        value = nameDraft,
                        onValueChange = { nameDraft = it },
                        label = "名称（如 GitHub CI 告警）",
                        singleLine = true,
                    )
                    AppTextField(
                        value = templateDraft,
                        onValueChange = { templateDraft = it },
                        label = "AI 提示词模板（支持 {{event}} 与 {{payload}}）",
                        minLines = 3,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !vm.webhooksBusy,
                    onClick = {
                        val name = nameDraft.trim()
                        val tpl = templateDraft.trim()
                        if (name.isEmpty() || tpl.isEmpty()) {
                            vm.webhooksActionError = "请填写名称和提示词模板"
                            return@TextButton
                        }
                        vm.createWebhook(name, tpl) { ok ->
                            if (ok) {
                                nameDraft = ""
                                showCreate = false
                            }
                        }
                    },
                ) { Text("创建") }
            },
            dismissButton = {
                TextButton(onClick = { showCreate = false }) { Text("取消") }
            },
        )
    }

    deleteTarget?.let { hook ->
        AppDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除 Webhook「${hook.name}」？") },
            text = { Text("删除后该入站地址与密钥会立即失效，无法撤销。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteWebhook(hook.id) { ok -> if (ok) deleteTarget = null }
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消") }
            },
        )
    }
}
