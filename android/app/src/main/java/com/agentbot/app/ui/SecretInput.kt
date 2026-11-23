package com.agentbot.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import com.agentbot.app.data.SecretRequest
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * The 安全输入 card under a reply whose Agent asked for a secret (`[[secret: NAME | 用途]]`).
 * The value is sent once to the server's vault and never stored on the phone: the field lives in
 * `remember` (not `rememberSaveable`, which the system writes to disk) and is cleared on success.
 */
@Composable
internal fun SecretRequestCard(vm: AppViewModel, taskId: String, request: SecretRequest) {
    var value by remember(taskId, request.name) { mutableStateOf("") }
    val busy = "$taskId/${request.name}" in vm.secretBusy
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = SurfaceHigh.copy(alpha = 0.5f),
        border = BorderStroke(1.dp, Border),
        modifier = Modifier.padding(top = 8.dp).fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                Text(
                    "AI 请求提供 ${request.name}",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            if (request.provided) {
                Text("✅ 已安全提供，AI 会继续执行", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
            } else {
                request.purpose?.let { Text("用途：$it", color = TextSecondary, style = MaterialTheme.typography.bodySmall) }
                SecretTextField(
                    value = value,
                    onValueChange = { value = it },
                    placeholder = request.name,
                    enabled = !busy,
                )
                Text(
                    "值只存进服务器的加密密钥库，不会发给 AI，24 小时后自动清除。",
                    color = TextTertiary,
                    style = MaterialTheme.typography.labelSmall,
                )
                if (vm.secretTransportExposed) {
                    Text(
                        "⚠️ 当前连接是 http 且没有配对加密密钥，值会以明文经过网络。建议改用 https，或扫码配对开启消息加密。",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { vm.provideSecret(taskId, request.name, value) { value = "" } },
                        enabled = value.isNotEmpty() && !busy,
                    ) {
                        Text(if (busy) "提交中…" else "提交")
                    }
                    TextButton(onClick = { vm.dismissSecret(taskId, request.name) }, enabled = !busy) {
                        Text("忽略")
                    }
                }
            }
        }
    }
}
