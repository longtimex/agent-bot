package com.agentbot.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.ApiFormat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.agentbot.app.ui.theme.TextSecondary

/** Server address + token entry, with a live connection test. */
@Composable
fun SettingsScreen(vm: AppViewModel, settings: com.agentbot.app.data.SettingsRepository) {
    var baseUrl by remember { mutableStateOf(settings.baseUrl) }
    var token by remember { mutableStateOf(settings.token) }
    var message by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@rememberLauncherForActivityResult
        runCatching {
            val obj = Json.parseToJsonElement(raw).jsonObject
            val scannedUrl = obj["url"]?.jsonPrimitive?.content.orEmpty()
            val scannedToken = obj["token"]?.jsonPrimitive?.content.orEmpty()
            if (scannedUrl.isBlank() || scannedToken.isBlank()) throw IllegalStateException("二维码缺少 url/token")
            val normalized = ApiFormat.normalizeBaseUrl(scannedUrl)
            baseUrl = normalized
            token = scannedToken
            vm.saveConnection(normalized, scannedToken)
        }.onFailure { message = "二维码无效：${it.message}" }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        Text("设置", style = MaterialTheme.typography.titleLarge)
        Text(
            "在服务器的 Telegram 聊天里发送 /api 即可获取这两项信息。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 6.dp, bottom = 18.dp),
        )

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            label = { Text("服务器地址") },
            placeholder = { Text("http://1.2.3.4:3080") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("访问令牌") },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
            singleLine = true,
        )

        Row(modifier = Modifier.padding(top = 20.dp)) {
            Button(
                onClick = {
                    testing = true
                    message = null
                    val normalized = ApiFormat.normalizeBaseUrl(baseUrl)
                    baseUrl = normalized
                    vm.saveConnection(normalized, token.trim())
                    testing = false
                },
                enabled = baseUrl.isNotBlank() && token.isNotBlank(),
            ) {
                Text(if (testing) "保存中…" else "保存并连接")
            }
            OutlinedButton(
                onClick = {
                    message = null
                    scanner.launch(
                        ScanOptions().apply {
                            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            setPrompt("对准 Bot 通过 /api 发来的配对二维码")
                            setBeepEnabled(false)
                            setOrientationLocked(true)
                        },
                    )
                },
                modifier = Modifier.padding(start = 12.dp),
            ) {
                Text("扫码配对")
            }
        }

        message?.let {
            Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
        }

        val health = vm.health
        if (health != null && health.ok) {
            Text(
                "✅ 已连接：${health.name ?: "agent-bot"}${health.version?.let { " $it" } ?: ""} · 引擎 ${health.engine ?: "?"}",
                color = com.agentbot.app.ui.theme.OkGreen,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 16.dp),
            )
        }
        vm.connectionError?.let {
            Text("⚠️ $it", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 16.dp))
        }
    }
}
