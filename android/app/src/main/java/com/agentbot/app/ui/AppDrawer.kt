package com.agentbot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Help
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Note
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.ScrollState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentbot.app.ui.theme.Border
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary

/** Grouped left drawer: conversation first, tooling and server controls behind clear headings. */
@Composable
fun AppDrawer(
    current: Screen,
    onNavigate: (Screen) -> Unit,
    onNewChat: () -> Unit,
    newChatEnabled: Boolean = true,
    connected: Boolean = false,
    sessionLabel: String? = null,
    queueCount: Int = 0,
    open: Boolean = false,
) {
    // A drawer is a map, not a document: reopening it must start at the first route. Keeping
    // the scroll position made every group above the last visit look missing on a short phone.
    val routeScroll = remember { ScrollState(0) }
    var wasOpen by remember { mutableStateOf(false) }
    // Only an edge from closed to open resets the map; a recomposition while it is open must
    // not yank the list back to the top under the user's finger.
    LaunchedEffect(open) {
        if (open && !wasOpen) routeScroll.scrollTo(0)
        wasOpen = open
    }
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.background,
        drawerContentColor = MaterialTheme.colorScheme.onBackground,
        modifier = Modifier.widthIn(max = 344.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .padding(horizontal = 14.dp, vertical = 16.dp),
        ) {
            BrandHeader(connected = connected, sessionLabel = sessionLabel)

            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 18.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .clickable(enabled = newChatEnabled, onClick = onNewChat),
                shape = RoundedCornerShape(16.dp),
                color = if (newChatEnabled) MaterialTheme.colorScheme.primary else SurfaceHigh.copy(alpha = 0.4f),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = null,
                        tint = if (newChatEnabled) MaterialTheme.colorScheme.onPrimary else TextSecondary,
                        modifier = Modifier.size(19.dp),
                    )
                    Text(
                        "新对话",
                        style = MaterialTheme.typography.labelLarge,
                        color = if (newChatEnabled) MaterialTheme.colorScheme.onPrimary else TextSecondary,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
            if (!newChatEnabled) {
                Text(
                    "当前任务仍在运行，停止后可开启新对话",
                    style = MaterialTheme.typography.labelSmall,
                    color = TextSecondary,
                    modifier = Modifier.padding(start = 4.dp, top = 7.dp),
                )
            }

            // The groups scroll as one surface so a short phone can still reach every page;
            // Settings stays outside it so it never covers the last entries.
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(top = 10.dp)
                    .verticalScroll(routeScroll),
            ) {
                Spacer(modifier = Modifier.padding(top = 6.dp))
                DrawerSection("对话")
                DrawerItem(Icons.Filled.History, "任务历史", current is Screen.History) { onNavigate(Screen.History) }
                DrawerItem(
                    Icons.Filled.List,
                    "任务队列",
                    current is Screen.Queue,
                    badge = queueCount.takeIf { it > 0 }?.toString(),
                ) { onNavigate(Screen.Queue) }

                DrawerSection("自动化")
                DrawerItem(Icons.Filled.Notifications, "提醒", current is Screen.Reminders) { onNavigate(Screen.Reminders) }
                DrawerItem(Icons.Filled.Schedule, "定时任务", current is Screen.Schedules) { onNavigate(Screen.Schedules) }
                DrawerItem(Icons.Filled.Bolt, "快捷指令", current is Screen.Aliases) { onNavigate(Screen.Aliases) }

                DrawerSection("智能体与工具")
                DrawerItem(Icons.Filled.Extension, "引擎管理", current is Screen.Agents) { onNavigate(Screen.Agents) }
                DrawerItem(Icons.Filled.Memory, "模型管理", current is Screen.Models) { onNavigate(Screen.Models) }
                DrawerItem(Icons.Filled.SwapHoriz, "cc-switch", current is Screen.Cc) { onNavigate(Screen.Cc) }
                DrawerItem(Icons.Filled.Bolt, "magpie 网关", current is Screen.Magpie) { onNavigate(Screen.Magpie) }
                DrawerItem(Icons.Filled.Note, "Hermes 记忆", current is Screen.Hermes) { onNavigate(Screen.Hermes) }

                DrawerSection("服务器")
                DrawerItem(Icons.Filled.Info, "运行状态", current is Screen.Status) { onNavigate(Screen.Status) }
                DrawerItem(Icons.Filled.Tune, "会话设置", current is Screen.Session) { onNavigate(Screen.Session) }
                DrawerItem(Icons.Filled.Lock, "访问白名单", current is Screen.Access) { onNavigate(Screen.Access) }
                DrawerItem(Icons.Filled.Public, "网络代理", current is Screen.Proxy) { onNavigate(Screen.Proxy) }
                DrawerItem(Icons.Filled.Build, "配置项", current is Screen.Config) { onNavigate(Screen.Config) }
                DrawerItem(Icons.Filled.Terminal, "运维中心", current is Screen.Ops) { onNavigate(Screen.Ops) }
                DrawerItem(Icons.Filled.Help, "帮助", current is Screen.Help) { onNavigate(Screen.Help) }
            }

            HorizontalDivider(color = Border.copy(alpha = 0.55f), modifier = Modifier.padding(top = 10.dp))
            DrawerItem(Icons.Filled.Settings, "设置", current is Screen.Settings) { onNavigate(Screen.Settings) }
        }
    }
}

@Composable
private fun BrandHeader(connected: Boolean, sessionLabel: String?) {
    Row(
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Surface(
            modifier = Modifier.size(38.dp),
            shape = RoundedCornerShape(12.dp),
            color = SurfaceHigh,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().fillMaxHeight(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Filled.Bolt,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(21.dp),
                )
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("Agent Bot", style = MaterialTheme.typography.titleSmall)
            Text(
                sessionLabel?.takeIf { it.isNotBlank() } ?: "云端 Agent 控制台",
                style = MaterialTheme.typography.labelSmall,
                color = TextSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        StatusPill(
            text = if (connected) "在线" else "离线",
            tone = if (connected) StatusTone.Success else StatusTone.Error,
        )
    }
}

@Composable
private fun DrawerSection(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = TextSecondary,
        modifier = Modifier.padding(start = 12.dp, top = 18.dp, bottom = 6.dp),
    )
}

@Composable
private fun DrawerItem(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    badge: String? = null,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp)
            .clip(RoundedCornerShape(13.dp))
            .clickable(onClick = onClick)
            .background(if (selected) SurfaceHigh.copy(alpha = 0.9f) else androidx.compose.ui.graphics.Color.Transparent)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (selected) MaterialTheme.colorScheme.onSurface else TextSecondary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (selected) MaterialTheme.colorScheme.onSurface else TextSecondary,
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        badge?.let {
            Surface(
                shape = MaterialTheme.shapes.extraSmall,
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = TextSecondary,
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
    }
}
