package com.agentbot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Help
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.Surface

/** Grok-style left drawer: primary destinations, current one highlighted. */
@Composable
fun AppDrawer(current: Screen, onNavigate: (Screen) -> Unit, onNewChat: () -> Unit) {
    ModalDrawerSheet(drawerContainerColor = Surface) {
        Column(
            modifier = Modifier
                .padding(12.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                "Agent Bot",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 16.dp),
            )

            DrawerItem(Icons.Filled.ChatBubble, "新会话", selected = false) {
                onNewChat()
                onNavigate(Screen.Chat)
            }
            DrawerItem(Icons.Filled.History, "任务历史", current is Screen.History) { onNavigate(Screen.History) }
            DrawerItem(Icons.Filled.Notifications, "提醒", current is Screen.Reminders) { onNavigate(Screen.Reminders) }
            DrawerItem(Icons.Filled.Schedule, "定时任务", current is Screen.Schedules) { onNavigate(Screen.Schedules) }
            DrawerItem(Icons.Filled.List, "任务队列", current is Screen.Queue) { onNavigate(Screen.Queue) }
            DrawerItem(Icons.Filled.Tune, "会话设置", current is Screen.Session) { onNavigate(Screen.Session) }
            DrawerItem(Icons.Filled.Bolt, "快捷指令", current is Screen.Aliases) { onNavigate(Screen.Aliases) }
            DrawerItem(Icons.Filled.Lock, "访问白名单", current is Screen.Access) { onNavigate(Screen.Access) }
            DrawerItem(Icons.Filled.Extension, "引擎管理", current is Screen.Agents) { onNavigate(Screen.Agents) }
            DrawerItem(Icons.Filled.Memory, "模型管理", current is Screen.Models) { onNavigate(Screen.Models) }
            DrawerItem(Icons.Filled.SwapHoriz, "cc-switch", current is Screen.Cc) { onNavigate(Screen.Cc) }
            DrawerItem(Icons.Filled.Build, "配置项", current is Screen.Config) { onNavigate(Screen.Config) }
            DrawerItem(Icons.Filled.Terminal, "运维中心", current is Screen.Ops) { onNavigate(Screen.Ops) }
            DrawerItem(Icons.Filled.Public, "网络代理", current is Screen.Proxy) { onNavigate(Screen.Proxy) }
            DrawerItem(Icons.Filled.Info, "运行状态", current is Screen.Status) { onNavigate(Screen.Status) }
            DrawerItem(Icons.Filled.Help, "帮助", current is Screen.Help) { onNavigate(Screen.Help) }
            Spacer(modifier = Modifier.height(8.dp))
            DrawerItem(Icons.Filled.Settings, "设置", current is Screen.Settings) { onNavigate(Screen.Settings) }
        }
    }
}

@Composable
private fun DrawerItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .background(
                if (selected) MaterialTheme.colorScheme.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent,
                RoundedCornerShape(24.dp),
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (selected) MaterialTheme.colorScheme.primary else TextSecondary,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(14.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
    }
}
