package com.agentbot.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
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
    var encKey by remember { mutableStateOf(settings.encKey) }
    var message by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@rememberLauncherForActivityResult
        runCatching {
            val obj = Json.parseToJsonElement(raw).jsonObject
            val scannedUrl = obj["url"]?.jsonPrimitive?.content.orEmpty().trim()
            val scannedToken = obj["token"]?.jsonPrimitive?.content.orEmpty().trim()
            if (scannedUrl.isBlank() || scannedToken.isBlank()) throw IllegalStateException("二维码缺少 url/token")
            val scannedEnc = obj["enc"]?.jsonPrimitive?.content.orEmpty().trim()
            val normalized = ApiFormat.normalizeBaseUrl(scannedUrl)
            baseUrl = normalized
            token = scannedToken
            encKey = scannedEnc
            vm.saveConnection(normalized, scannedToken, scannedEnc.ifBlank { null })
        }.onFailure { message = "二维码无效：${it.message}" }
    }

    val context = LocalContext.current
    val startScan = {
        scanner.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("对准 Bot 通过 /api 发来的配对二维码")
                setBeepEnabled(false)
                setOrientationLocked(true)
            },
        )
    }
    // zxing's CaptureActivity opens the camera inside this process, so the declared CAMERA
    // permission has to be granted at runtime first or the preview dies on SecurityException.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startScan() else message = "需要相机权限才能扫码配对"
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
            placeholder = { Text("https://bot.example.com") },
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
        OutlinedTextField(
            value = encKey,
            onValueChange = { encKey = it },
            label = { Text("加密密钥（可选，服务器 API_ENCRYPTION=1 时由 /api 二维码下发）") },
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
                    vm.saveConnection(normalized, token.trim(), encKey.trim().ifBlank { null })
                    testing = false
                },
                enabled = baseUrl.isNotBlank() && token.isNotBlank(),
            ) {
                Text(if (testing) "保存中…" else "保存并连接")
            }
            OutlinedButton(
                onClick = {
                    message = null
                    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
                    if (granted) startScan() else cameraPermission.launch(Manifest.permission.CAMERA)
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
            Text(
                if (health.encryption) "🔐 消息级加密：已启用（请求与响应自动加密）" else "🔒 消息级加密：服务器未开启（API_ENCRYPTION=1 可启用）",
                color = if (health.encryption) com.agentbot.app.ui.theme.OkGreen else TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        vm.connectionError?.let {
            Text("⚠️ $it", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 16.dp))
        }

        AppUpdateCard(vm)
    }
}

@Composable
private fun AppUpdateCard(vm: AppViewModel) {
    val release = vm.androidRelease
    val current = vm.appVersionName.ifBlank { vm.appVersionCode.toString() }
    Column(modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
        Text("应用更新", style = MaterialTheme.typography.titleSmall)
        Text(
            "当前版本：$current（${vm.appVersionCode}）",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 6.dp),
        )
        if (release?.configured == true) {
            val latest = release.versionName ?: release.versionCode?.toString() ?: "—"
            Text(
                "服务器最新：$latest" + if (release.size > 0) " · ${formatSize(release.size)}" else "",
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
            if (release.notes.isNotBlank()) {
                Text(
                    release.notes,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        } else if (!release?.message.isNullOrBlank()) {
            Text(release!!.message!!, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
        }
        vm.appUpdateError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
        }
        Row(modifier = Modifier.padding(top = 10.dp)) {
            OutlinedButton(onClick = { vm.refreshAndroidRelease() }) { Text("检查更新") }
            Button(
                onClick = { vm.downloadAndInstallAppUpdate() },
                enabled = vm.appUpdateStage == null && release?.updateAvailable == true,
                modifier = Modifier.padding(start = 12.dp),
            ) {
                Text(vm.appUpdateStage ?: if (release?.updateAvailable == true) "下载并安装" else "已是最新")
            }
        }
        Text(
            "APK 通过当前连接下载并校验 SHA-256。若从早期 debug 签名包切换到正式签名包，Android 会拒绝覆盖安装：需要先卸载旧版，本机聊天记录与设置会一并清除。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

private fun formatSize(bytes: Long): String = when {
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1_024 -> "%.0f KB".format(bytes / 1_024.0)
    else -> "$bytes B"
}
