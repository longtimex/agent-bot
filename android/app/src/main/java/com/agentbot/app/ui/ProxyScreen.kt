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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Stop
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
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ProxyInfo
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/** Telegram's /proxy panel: add, test, enable and remove outbound proxies. */
@Composable
fun ProxyScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<ProxyInfo?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "网络代理",
            subtitle = "管理 Bot 的出站代理",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "添加代理",
                    onClick = {
                        vm.proxyActionError = null
                        vm.proxyDraftRejected = false
                        adding = true
                    },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新代理",
                    onClick = vm::refreshProxies,
                )
            }
        )

        Text(
            "仅 Bot 下载媒体时走代理；Telegram 与本地 OpenCode 流量保持直连。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

        if (vm.proxyBusy) {
            LoadingBar(
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 10.dp),
            )
        }

        PageErrorNotice(
            message = vm.proxyActionError,
            onDismiss = { vm.proxyActionError = null },
        )

        vm.proxyTestMessage?.let { message ->
            val ok = message.startsWith("连接正常")
            InlineNotice(
                text = message,
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 6.dp),
                tone = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                icon = if (ok) Icons.Filled.CheckCircle else Icons.Filled.Error,
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
        ) {
            val loadError = vm.proxiesError
            if (loadError != null) {
                item {
                    PageLoadError(
                        title = "暂时无法加载代理",
                        message = loadError,
                        icon = Icons.Filled.Settings,
                        modifier = Modifier.fillParentMaxSize(),
                        onRetry = vm::refreshProxies,
                    )
                }
            } else if (vm.proxies.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.Filled.Settings,
                        title = "尚未添加代理",
                        message = "点右上角 + 添加；保存前会先测试连通性，超时 10 秒。",
                    )
                }
            }
            if (loadError == null) {
                items(vm.proxies, key = { it.id }) { proxy ->
                    ProxyCard(vm, proxy, onDelete = {
                        vm.proxyActionError = null
                        pendingRemove = proxy
                    })
                }
                if (vm.activeProxyId != null) {
                    item {
                        QuietButton(
                            text = "停用代理",
                            icon = Icons.Filled.Stop,
                            enabled = !vm.proxyBusy,
                            danger = true,
                            onClick = vm::disableProxy,
                        )
                    }
                }
            }
        }
    }

    if (adding) {
        TextPromptDialog(
            title = "添加代理",
            hint = "支持 http、https、socks4、socks5，可带用户名密码。格式：地址 [名称]。添加前会先测试连通性。",
            confirmLabel = "添加",
            placeholder = "socks5://127.0.0.1:1080 本地代理",
            error = vm.proxyActionError.takeIf { vm.proxyDraftRejected },
            onDismiss = {
                adding = false
                vm.proxyActionError = null
                vm.proxyDraftRejected = false
            },
            onConfirm = { input ->
                vm.addProxy(input) { ok -> if (ok) adding = false }
            },
        )
    }

    pendingRemove?.let { proxy ->
        AlertDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("删除代理？", style = MaterialTheme.typography.titleLarge) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("将从 Bot 中移除「${proxy.name.ifBlank { proxy.url }}」。", style = MaterialTheme.typography.bodyMedium)
                    vm.proxyActionError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.removeProxy(proxy.id) { ok -> if (ok) pendingRemove = null }
                }) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemove = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ProxyCard(vm: AppViewModel, proxy: ProxyInfo, onDelete: () -> Unit) {
    AppCard(contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                proxy.name.ifBlank { "代理 #${proxy.id}" },
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            if (proxy.active) {
                StatusPill(text = "已启用", tone = StatusTone.Success)
            } else {
                StatusPill(text = proxy.protocol?.uppercase() ?: "未启用")
            }
        }
        Text(
            proxy.url,
            color = TextTertiary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(
            modifier = Modifier.padding(top = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!proxy.active) {
                QuietButton(
                    text = "启用",
                    icon = Icons.Filled.PlayArrow,
                    enabled = !vm.proxyBusy,
                    onClick = { vm.useProxy(proxy.id) },
                )
            }
            QuietButton(
                text = "测试",
                icon = Icons.Filled.Speed,
                enabled = !vm.proxyBusy,
                onClick = { vm.testProxy(proxy.id) },
            )
            QuietButton(
                text = "删除",
                icon = Icons.Filled.DeleteOutline,
                enabled = !vm.proxyBusy,
                danger = true,
                onClick = onDelete,
            )
        }
    }
}
