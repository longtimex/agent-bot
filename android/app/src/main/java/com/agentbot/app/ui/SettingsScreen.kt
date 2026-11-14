package com.agentbot.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.agentbot.app.data.ApiFormat
import com.agentbot.app.data.formatFileSize
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.OkGreen
import com.agentbot.app.ui.theme.TextSecondary
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Server address + token entry, with address preview, loopback guard and a live connection test. */
@Composable
fun SettingsScreen(vm: AppViewModel, settings: com.agentbot.app.data.SettingsRepository) {
    var baseUrl by remember { mutableStateOf(settings.baseUrl) }
    var token by remember { mutableStateOf(settings.token) }
    var encKey by remember { mutableStateOf(settings.encKey) }
    var message by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var scanned by remember { mutableStateOf(false) }
    var secretsVisible by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val normalized = ApiFormat.normalizeBaseUrl(baseUrl)
    val warning = ApiFormat.connectionWarning(normalized)
    // A rejected probe for a new address says nothing about the saved one, which is still live.
    val healthy = vm.health != null && vm.health?.ok == true
    val secretTransformation = if (secretsVisible) VisualTransformation.None else PasswordVisualTransformation()

    fun connect() {
        if (testing) return
        if (normalized.isBlank() || token.isBlank()) {
            message = "请填写服务器地址与访问令牌"
            return
        }
        val hadConnection = settings.connection() != null
        testing = true
        message = null
        vm.connectionProbeError = null
        scope.launch {
            val result = vm.saveConnection(normalized, token.trim(), encKey.trim().ifBlank { null })
            testing = false
            if (result.isSuccess) {
                baseUrl = normalized
                message = "连接成功，即将返回聊天"
                // Keep the success notice on screen long enough to be read; returning at once
                // made a successful save indistinguishable from no visible effect at all.
                delay(1_500)
                vm.navigate(Screen.Chat)
            } else {
                // saveConnection probes before writing, so a previously working pairing survives.
                val prefix = if (hadConnection) {
                    "连接失败，已保留原配置。"
                } else {
                    "连接失败，尚未保存。"
                }
                // The prefix already says the pairing failed; keep the actual cause, not
                // "连接失败" twice. The probe owns the reason and the form owns the outcome.
                val detail = vm.connectionProbeError
                    ?.removePrefix("连接失败：")
                    ?.takeIf { it.isNotBlank() }
                    ?: "请检查地址、令牌和隧道状态"
                message = prefix + "\n" + detail
            }
        }
    }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@rememberLauncherForActivityResult
        runCatching {
            val obj = Json.parseToJsonElement(raw).jsonObject
            val scannedUrl = obj["url"]?.jsonPrimitive?.content.orEmpty().trim()
            val scannedToken = obj["token"]?.jsonPrimitive?.content.orEmpty().trim()
            if (scannedUrl.isBlank() || scannedToken.isBlank()) throw IllegalStateException("二维码缺少 url/token")
            val scannedEnc = obj["enc"]?.jsonPrimitive?.content.orEmpty().trim()
            baseUrl = ApiFormat.normalizeBaseUrl(scannedUrl)
            token = scannedToken
            encKey = scannedEnc
            scanned = true
            message = "已导入二维码信息。请确认地址预览无误后点「保存并连接」。"
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
            .padding(horizontal = AppSpacing.screen, vertical = 18.dp),
    ) {
        ScreenHeader(
            title = "设置",
            subtitle = "连接云端 Agent",
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                StatusPill(
                    text = if (healthy) "已连接" else "未连接",
                    tone = if (healthy) StatusTone.Success else StatusTone.Warning,
                )
            },
        )
        Text(
            "在服务器的 Telegram / 飞书聊天里发送 /api 获取地址与令牌；云电脑需先把端口发布成手机可达的 HTTPS 地址。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 10.dp, bottom = 22.dp),
        )

        SectionHeader(title = "连接", subtitle = "服务器地址与访问令牌只保存在本机")
        AppCard(
            modifier = Modifier.padding(top = 10.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp),
        ) {
            AppTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it; scanned = false },
                label = "服务器地址",
                placeholder = "https://bot.example.com",
                maxLines = 3,
            )
            if (normalized.isNotBlank()) {
                Text(
                    "API · ${ApiFormat.apiUrl(normalized)}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 7.dp, start = 4.dp),
                )
            }
            warning?.let {
                InlineNotice(
                    text = it,
                    modifier = Modifier.padding(top = 10.dp),
                    tone = MaterialTheme.colorScheme.error,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Text(
                    if (secretsVisible) "凭据当前可见，注意遮挡屏幕" else "凭据已隐藏",
                    color = if (secretsVisible) MaterialTheme.colorScheme.error else TextSecondary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.weight(1f),
                )
                QuietButton(
                    text = if (secretsVisible) "隐藏" else "显示",
                    icon = if (secretsVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                    onClick = { secretsVisible = !secretsVisible },
                )
            }
            AppTextField(
                value = token,
                onValueChange = { token = it; scanned = false },
                label = "访问令牌",
                placeholder = "从 /api 配对信息中获取",
                singleLine = true,
                visualTransformation = secretTransformation,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            )
            AppTextField(
                value = encKey,
                onValueChange = { encKey = it },
                label = "加密密钥（可选）",
                placeholder = "服务器开启 API_ENCRYPTION 时填写",
                singleLine = true,
                visualTransformation = secretTransformation,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.padding(top = 12.dp),
            )

            if (scanned) {
                InlineNotice(
                    text = "二维码已导入但尚未保存。云电脑地址可能随端口发布变化，请核对后再连接。",
                    modifier = Modifier.padding(top = 12.dp),
                    icon = Icons.Filled.Info,
                )
            }

            Row(modifier = Modifier.padding(top = 18.dp)) {
                PrimaryButton(
                    text = if (testing) "连接中…" else "保存并连接",
                    modifier = Modifier.weight(1f),
                    enabled = !testing && baseUrl.isNotBlank() && token.isNotBlank(),
                    onClick = { connect() },
                )
                Spacer(modifier = Modifier.width(AppSpacing.sm))
                SecondaryButton(
                    text = "扫码",
                    icon = Icons.Filled.QrCodeScanner,
                    onClick = {
                        message = null
                        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                            PackageManager.PERMISSION_GRANTED
                        if (granted) startScan() else cameraPermission.launch(Manifest.permission.CAMERA)
                    },
                )
            }

            message?.let {
                InlineNotice(
                    text = it,
                    modifier = Modifier.padding(top = 12.dp),
                    tone = if (it.startsWith("连接成功")) OkGreen else MaterialTheme.colorScheme.error,
                    icon = if (it.startsWith("连接成功")) Icons.Filled.Check else Icons.Filled.Info,
                )
            }
        }

        val health = vm.health
        if (healthy && health != null) {
            SectionHeader(
                title = "当前连接",
                modifier = Modifier.padding(top = 26.dp),
            )
            AppCard(modifier = Modifier.padding(top = 10.dp)) {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    StatusPill("已连接", tone = StatusTone.Success)
                    Text(
                        "${health.name ?: "agent-bot"}${health.version?.let { " $it" } ?: ""}",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
                Text(
                    "引擎：${health.engine ?: "?"}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Text(
                    if (health.encryption) "消息级加密已启用" else "服务器未开启消息级加密",
                    color = if (health.encryption) com.agentbot.app.ui.theme.OkGreen else TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
        vm.connectionError?.let {
            InlineNotice(
                text = it,
                modifier = Modifier.padding(top = 16.dp),
                tone = MaterialTheme.colorScheme.error,
                icon = Icons.Filled.Info,
            )
        }

        AppUpdateCard(vm)
    }
}

@Composable
private fun AppUpdateCard(vm: AppViewModel) {
    val release = vm.androidRelease
    val current = vm.appVersionName.ifBlank { vm.appVersionCode.toString() }
    SectionHeader(
        title = "应用更新",
        subtitle = "通过当前服务器下载并校验 APK",
        modifier = Modifier.padding(top = 26.dp),
    )
    AppCard(modifier = Modifier.padding(top = 10.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Column {
                Text("当前版本", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "$current · ${vm.appVersionCode}",
                    color = TextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            if (release?.configured == true) {
                StatusPill(
                    text = if (release.updateAvailable == true) "有更新" else "已是最新",
                    tone = if (release.updateAvailable == true) StatusTone.Warning else StatusTone.Success,
                )
            }
        }
        if (release?.configured == true) {
            val latest = release.versionName ?: release.versionCode?.toString() ?: "—"
            Text(
                "服务器最新：$latest" + if (release.size > 0) " · ${formatFileSize(release.size)}" else "",
                color = TextSecondary,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 12.dp),
            )
            if (release.notes.isNotBlank()) {
                Text(
                    release.notes,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        } else if (!release?.message.isNullOrBlank()) {
            Text(release!!.message!!, color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        } else if (release == null && vm.appUpdateError == null) {
            Text("正在读取更新清单…", color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
        vm.appUpdateError?.let {
            InlineNotice(
                text = it,
                modifier = Modifier.padding(top = 10.dp),
                tone = MaterialTheme.colorScheme.error,
            )
        }
        Row(modifier = Modifier.padding(top = 14.dp)) {
            SecondaryButton(text = "检查更新", onClick = { vm.refreshAndroidRelease() })
            Spacer(modifier = Modifier.width(AppSpacing.sm))
            PrimaryButton(
                text = vm.appUpdateStage ?: when {
                    release?.updateAvailable == true -> "下载并安装"
                    release?.configured != true -> "暂不可更新"
                    else -> "已是最新"
                },
                modifier = Modifier.weight(1f),
                enabled = vm.appUpdateStage == null && release?.updateAvailable == true,
                onClick = { vm.downloadAndInstallAppUpdate() },
            )
        }
        Text(
            "若从 debug 签名包切换到正式签名包，Android 会拒绝覆盖安装：需要先卸载旧版，本机聊天记录与设置会一并清除。",
            color = TextSecondary,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}
