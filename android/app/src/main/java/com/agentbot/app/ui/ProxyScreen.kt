package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
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
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's /proxy panel: add, test, enable and remove outbound proxies. */
@Composable
fun ProxyScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("网络代理", style = MaterialTheme.typography.titleLarge)
            Row {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("添加", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(onClick = vm::refreshProxies) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("刷新", modifier = Modifier.padding(start = 4.dp))
                }
            }
        }

        Text(
            "仅 Bot 下载媒体时走代理；Telegram 与本地 OpenCode 流量保持直连。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 20.dp),
        )

        if (vm.proxyBusy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        vm.proxyTestMessage?.let { message ->
            Text(
                message,
                color = if (message.startsWith("✅")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.proxies.isEmpty()) {
                item {
                    Text(
                        "尚未添加代理。添加时会先测试连通性（10 秒超时）。",
                        color = TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            items(vm.proxies, key = { it.id }) { proxy ->
                ProxyCard(vm, proxy)
            }
            if (vm.activeProxyId != null) {
                item {
                    TextButton(enabled = !vm.proxyBusy, onClick = vm::disableProxy) {
                        Text("⏹ 停用代理", color = MaterialTheme.colorScheme.error)
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
            onDismiss = { adding = false },
            onConfirm = { input ->
                vm.addProxy(input)
                adding = false
            },
        )
    }
}

@Composable
private fun ProxyCard(vm: AppViewModel, proxy: ProxyInfo) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("#${proxy.id} ${proxy.name}", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Text(
                    if (proxy.active) "已启用" else proxy.protocol?.uppercase() ?: "",
                    color = if (proxy.active) MaterialTheme.colorScheme.primary else TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Text(proxy.url, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (!proxy.active) {
                    TextButton(enabled = !vm.proxyBusy, onClick = { vm.useProxy(proxy.id) }) { Text("▶️ 启用") }
                }
                TextButton(enabled = !vm.proxyBusy, onClick = { vm.testProxy(proxy.id) }) { Text("🧪 测试") }
                TextButton(enabled = !vm.proxyBusy, onClick = { vm.removeProxy(proxy.id) }) {
                    Text("🗑 删除", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}
