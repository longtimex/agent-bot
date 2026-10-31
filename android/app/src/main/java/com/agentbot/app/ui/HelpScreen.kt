package com.agentbot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.TextSecondary

/** Telegram's `/help`, `/help full` and `/help cc` in one selectable, scrollable panel. */
@Composable
fun HelpScreen(vm: AppViewModel) {
    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("帮助", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = vm::refreshHelp) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Text("刷新", modifier = Modifier.padding(start = 4.dp))
            }
        }

        val sections = vm.helpView?.sections.orEmpty()
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (sections.isEmpty()) {
                Text("正在加载帮助…", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
            } else {
                sections.forEach { section ->
                    FilterChip(
                        selected = section.id == vm.helpSection,
                        onClick = { vm.selectHelpSection(section.id) },
                        label = { Text(section.title) },
                    )
                }
            }
        }

        if (vm.helpView == null) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            return@Column
        }

        val section = sections.firstOrNull { it.id == vm.helpSection } ?: sections.firstOrNull()
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 4.dp),
        ) {
            SelectionContainer {
                Text(
                    section?.text ?: "暂无帮助内容，点击刷新重试。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (section == null) TextSecondary else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                )
            }
        }
    }
}
