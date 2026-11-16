package com.agentbot.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentbot.app.ui.theme.AppRadius
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.TextPrimary
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * The one dialog shell everything else builds on. Cards, fields and dialogs share the radius
 * ladder and the surface/border pair, so a confirmation box no longer looks like it came from
 * a different app than the list behind it.
 *
 * [scrollable] is opt-in: a body that already scrolls on its own (a LazyColumn) must not get a
 * second vertical scroll container, or Compose throws on the nested measurement.
 */
@Composable
fun AppDialog(
    onDismissRequest: () -> Unit,
    title: @Composable () -> Unit,
    text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: (@Composable () -> Unit)? = null,
    scrollable: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismissRequest,
        shape = RoundedCornerShape(AppRadius.xl),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        titleContentColor = TextPrimary,
        textContentColor = TextSecondary,
        title = {
            Column(modifier = Modifier.fillMaxWidth()) {
                title()
                HorizontalDivider(
                    color = Border.copy(alpha = 0.6f),
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        },
        text = {
            if (scrollable) {
                Column(
                    modifier = Modifier
                        .heightIn(max = 460.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    text()
                }
            } else {
                text()
            }
        },
        confirmButton = confirmButton,
        dismissButton = dismissButton,
    )
}

/**
 * Read-only output: a CLI dump, a config file, a status report. Long bodies scroll inside the
 * sheet instead of pushing the list behind it, and the whole text is one tap away from the
 * clipboard — selecting a page of JSON by hand was the old way.
 */
@Composable
fun AppOutputDialog(title: String, text: String, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    val body = text.ifBlank { "（无输出）" }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(horizontal = 16.dp, vertical = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(AppRadius.xl),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                border = BorderStroke(1.dp, Border.copy(alpha = 0.72f)),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            title,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.titleSmall,
                            color = TextPrimary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(onClick = {
                            clipboard.setText(AnnotatedString(body))
                            copied = true
                        }) { Text(if (copied) "已复制" else "复制") }
                    }
                    HorizontalDivider(color = Border.copy(alpha = 0.6f))
                    SelectionContainerText(body)
                    HorizontalDivider(color = Border.copy(alpha = 0.6f))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${body.length} 字符",
                            modifier = Modifier.weight(1f).padding(start = 8.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextTertiary,
                        )
                        TextButton(onClick = onDismiss) { Text("关闭") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SelectionContainerText(text: String) {
    androidx.compose.foundation.text.selection.SelectionContainer {
        Text(
            text,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 420.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 14.dp),
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        )
    }
}
