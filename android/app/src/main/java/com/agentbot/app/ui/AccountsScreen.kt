package com.agentbot.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VpnKey
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.AccountEntry
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * Telegram's `/account` panel: named credentials under free-form categories.
 *
 * The list never carries a password. A reveal is a separate, explicit request whose answer is
 * kept only in memory for the entry the user opened, and the map is dropped on every refresh.
 */
@Composable
fun AccountsScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<AccountEntry?>(null) }
    var pendingDelete by remember { mutableStateOf<AccountEntry?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "账号库",
            subtitle = "密码加密保存，分类自由定义",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "新增账号",
                    onClick = {
                        vm.accountError = null
                        adding = true
                    },
                )
                AppIconButton(
                    icon = Icons.Filled.Refresh,
                    contentDescription = "刷新账号库",
                    onClick = vm::refreshAccounts,
                )
            },
        )

        Text(
            "密码以 AES-256-GCM 加密存放在服务器，密钥单独保存且不进备份包。列表不返回明文，点开条目按需显示。",
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = AppSpacing.screen, end = AppSpacing.screen, top = 6.dp),
        )

        val loadError = vm.accountError?.takeIf { vm.accounts.isEmpty() && vm.accountCategories.isEmpty() }
        if (loadError != null) {
            PageLoadError(
                title = "暂时无法加载账号库",
                message = loadError,
                icon = Icons.Filled.VpnKey,
                onRetry = vm::refreshAccounts,
            )
        } else {
            // Only action failures reach here; a load failure took the branch above.
            PageErrorNotice(
                message = vm.accountError,
                onDismiss = { vm.accountError = null },
            )
            if (vm.accountCategories.isNotEmpty()) {
                CategoryChips(vm)
            }
            val visible = vm.accountFilter?.let { category ->
                vm.accounts.filter { it.category == category }
            } ?: vm.accounts
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = AppSpacing.screen, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AppSpacing.sm),
            ) {
                if (visible.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Filled.VpnKey,
                            title = if (vm.accounts.isEmpty()) "账号库还是空的" else "这个分类下没有条目",
                            message = "点右上角 + 新增一条，例如 GitHub / 邮箱 / 服务器。",
                        )
                    }
                }
                items(visible, key = { it.id }) { entry ->
                    AccountCard(entry) { detail = entry }
                }
            }
        }
    }

    if (adding) {
        AddAccountDialog(
            busy = vm.accountBusy,
            onDismiss = { adding = false },
            onSave = { name, username, password, category, url, notes ->
                adding = false
                vm.addAccount(name, username, password, category, url, notes)
            },
        )
    }

    detail?.let { entry ->
        AccountDetailDialog(
            entry = entry,
            password = vm.revealedAccounts[entry.id],
            onReveal = { vm.revealAccount(entry.id) },
            onHide = { vm.hideAccount(entry.id) },
            onDelete = {
                detail = null
                pendingDelete = entry
            },
            onDismiss = { detail = null },
        )
    }

    pendingDelete?.let { entry ->
        AppDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除「${entry.name}」？", style = MaterialTheme.typography.titleLarge) },
            text = { Text("删除后该条目的账号与密码都无法恢复。", style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteAccount(entry.id)
                    pendingDelete = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun CategoryChips(vm: AppViewModel) {
    LazyRow(
        contentPadding = PaddingValues(start = AppSpacing.screen, end = AppSpacing.screen, top = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            CategoryChip("全部 ${vm.accounts.size}", vm.accountFilter == null) { vm.setAccountFilter(null) }
        }
        items(vm.accountCategories, key = { it.name }) { category ->
            CategoryChip(
                label = "${category.name} ${category.count}",
                selected = vm.accountFilter == category.name,
            ) { vm.setAccountFilter(category.name) }
        }
    }
}

@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(50),
        color = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f) else SurfaceHigh,
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.primary else TextSecondary,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun AccountCard(entry: AccountEntry, onOpen: () -> Unit) {
    AppCard(
        contentPadding = PaddingValues(horizontal = AppSpacing.lg, vertical = 14.dp),
        onClick = onOpen,
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                entry.name,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            if (entry.hasPassword) {
                Icon(
                    Icons.Filled.Lock,
                    contentDescription = "已保存密码",
                    tint = TextTertiary,
                    modifier = Modifier.padding(end = 6.dp),
                )
            }
            StatusPill(text = entry.category)
        }
        Text(
            entry.username.ifBlank { "（未填写账号）" },
            color = TextSecondary,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 5.dp),
        )
        entry.url?.takeIf { it.isNotBlank() }?.let { url ->
            Text(
                url,
                color = TextTertiary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

@Composable
private fun AccountDetailDialog(
    entry: AccountEntry,
    password: String?,
    onReveal: () -> Unit,
    onHide: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    AppDialog(
        onDismissRequest = onDismiss,
        scrollable = true,
        title = { Text(entry.name, style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DetailRow("分类", entry.category)
                DetailRow("账号", entry.username.ifBlank { "（空）" })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("密码", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                    Text(
                        when {
                            password != null -> password
                            entry.hasPassword -> "********"
                            else -> "（未保存）"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f).padding(start = 12.dp),
                    )
                    if (entry.hasPassword) {
                        TextButton(onClick = if (password == null) onReveal else onHide) {
                            Text(if (password == null) "显示" else "隐藏")
                        }
                    }
                }
                entry.url?.takeIf { it.isNotBlank() }?.let { DetailRow("网址", it) }
                entry.notes?.takeIf { it.isNotBlank() }?.let { DetailRow("备注", it) }
            }
        },
        confirmButton = {
            TextButton(onClick = onDelete) { Text("删除", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("关闭") }
        },
    )
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f).padding(start = 12.dp),
        )
    }
}

@Composable
private fun AddAccountDialog(
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String?, String?, String?, String?) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }

    AppDialog(
        onDismissRequest = onDismiss,
        scrollable = true,
        title = { Text("新增账号", style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AppTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = "名称（必填）",
                    placeholder = "GitHub",
                    singleLine = true,
                )
                AppTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = "账号",
                    placeholder = "me@example.com",
                    singleLine = true,
                )
                AppTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = "密码",
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                AppTextField(
                    value = category,
                    onValueChange = { category = it },
                    label = "分类",
                    placeholder = "留空归入「未分类」",
                    singleLine = true,
                )
                AppTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = "网址",
                    singleLine = true,
                )
                AppTextField(
                    value = notes,
                    onValueChange = { notes = it },
                    label = "备注",
                    minLines = 2,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && name.isNotBlank(),
                onClick = {
                    onSave(
                        name.trim(),
                        username.trim(),
                        password.takeIf { it.isNotBlank() },
                        category.trim().takeIf { it.isNotBlank() },
                        url.trim().takeIf { it.isNotBlank() },
                        notes.trim().takeIf { it.isNotBlank() },
                    )
                },
            ) { Text(if (busy) "保存中…" else "保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
