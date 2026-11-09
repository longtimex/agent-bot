package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's `/help`, `/help full` and `/help cc` in one selectable, scrollable panel. */
@Composable
fun HelpScreen(vm: AppViewModel) {
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "帮助",
            subtitle = "命令词典与使用说明",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新帮助",
                    onClick = vm::refreshHelp,
                )
            },
        )

        val sections = vm.helpView?.sections.orEmpty()
        if (sections.isEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = AppSpacing.screen, vertical = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("正在加载帮助…", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = AppSpacing.screen, vertical = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                sections.forEach { section ->
                    ChoicePill(
                        text = section.title,
                        selected = section.id == vm.helpSection,
                        onClick = { vm.selectHelpSection(section.id) },
                    )
                }
            }
        }

        if (vm.helpView == null) {
            LoadingBar(modifier = Modifier.padding(horizontal = AppSpacing.screen))
            return@Column
        }

        val section = sections.firstOrNull { it.id == vm.helpSection } ?: sections.firstOrNull()
        AppCard(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = AppSpacing.screen, vertical = 4.dp),
            contentPadding = PaddingValues(0.dp),
        ) {
            SelectionContainer {
                Text(
                    section?.text ?: "暂无帮助内容，点击刷新重试。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (section == null) TextSecondary else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 18.dp, vertical = 18.dp),
                )
            }
        }
    }
}
