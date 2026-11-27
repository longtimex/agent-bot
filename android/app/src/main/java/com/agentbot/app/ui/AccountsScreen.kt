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
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentbot.app.data.AccountEntry
import com.agentbot.app.ui.theme.AppSpacing
import com.agentbot.app.ui.theme.SurfaceHigh
import com.agentbot.app.ui.theme.TextSecondary
import com.agentbot.app.ui.theme.TextTertiary

/**
 * Telegram's /account panel: named credentials under free-form categories and tags.
 *
 * The list never carries a password. A reveal is a separate, explicit request whose answer is
 * kept only in memory for the entry the user opened, and the map is dropped on every refresh.
 */
@Composable
fun AccountsScreen(vm: AppViewModel) {
    var formOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<AccountEntry?>(null) }
    var detail by remember { mutableStateOf<AccountEntry?>(null) }
    var pendingDelete by remember { mutableStateOf<AccountEntry?>(null) }
    var query by remember { mutableStateOf("") }

    // Leaving the screen must not leave a decrypted password in memory
    DisposableEffect(Unit) {
        onDispose { vm.forgetRevealedAccounts() }
    }

    Column(modifier = Modifier.fillMaxSize().padding(top = 16.dp)) {
        ScreenHeader(
            title = "账号库",
            subtitle = "密码加密保存，分类与标签可自定义",
            modifier = Modifier.padding(horizontal = AppSpacing.screen),
            onBack = { vm.navigate(Screen.Chat) },
            trailing = {
                AppIconButton(
                    icon = Icons.Filled.Add,
                    contentDescription = "新增账号",
                    onClick = {
                        vm.accountError = null
                        editing = null
                        formOpen = true
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

        val loadError = vm.accountLoadError?.takeIf { vm.accounts.isEmpty() && vm.accountCategories.isEmpty() }
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
                // A refresh that failed while data is on screen belongs here, not in the page
                message = vm.accountError ?: vm.accountLoadError,
                onDismiss = {
                    vm.accountError = null
                    vm.accountLoadError = null
                },
            )
            if (vm.accountCategories.isNotEmpty()) {
                CategoryChips(vm)
            }
            AppTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = "搜索名称、账号或标签",
                singleLine = true,
                modifier = Modifier.padding(horizontal = AppSpacing.screen, vertical = 8.dp),
            )
            val keyword = query.trim()
            val visible = vm.accounts.filter { entry ->
                val inCategory = vm.accountFilter == null || entry.category == vm.accountFilter
                val matches = keyword.isEmpty() ||
                    (listOf(entry.name, entry.username, entry.category) + entry.tags)
                        .any { it.contains(keyword, ignoreCase = true) }
                inCategory && matches
            }
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
                            message = "点右上角 + 新增一条，例如 GitHub / 邮箱 / 社交平台。",
                        )
                    }
                }
                items(visible, key = { it.id }) { entry ->
                    AccountCard(entry) { detail = entry }
                }
            }
        }
    }

    if (formOpen) {
        AccountFormDialog(
            initial = editing,
            busy = vm.accountBusy,
            onDismiss = {
                formOpen = false
                editing = null
            },
            onSave = { name, username, password, category, url, notes, tags, extras ->
                val target = editing
                formOpen = false
                editing = null
                if (target == null) {
                    vm.addAccount(name, username, password, category, url, notes, tags, extras)
                } else {
                    vm.updateAccount(target.id, name, username, password, category, url, notes, tags, extras)
                }
            },
        )
    }

    detail?.let { entry ->
        AccountDetailDialog(
            entry = entry,
            password = vm.revealedAccounts[entry.id],
            error = vm.accountError,
            onReveal = { vm.revealAccount(entry.id) },
            onHide = { vm.hideAccount(entry.id) },
            onEdit = {
                detail = null
                vm.accountError = null
                editing = entry
                formOpen = true
            },
            onDelete = {
                detail = null
                pendingDelete = entry
            },
            onDismiss = {
                vm.hideAccount(entry.id)
                vm.accountError = null
                detail = null
            },
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
            CategoryChip("全部 ${vm.accounts.size}", vm.accountFilter == null) { vm.filterAccounts(null) }
        }
        items(vm.accountCategories, key = { it.name }) { category ->
            CategoryChip(
                label = "${category.name} ${category.count}",
                selected = vm.accountFilter == category.name,
            ) { vm.filterAccounts(category.name) }
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
        if (entry.tags.isNotEmpty()) {
            Text(
                entry.tags.joinToString(" ") { "#$it" },
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 5.dp),
            )
        }
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
    error: String?,
    onReveal: () -> Unit,
    onHide: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    AppDialog(
        onDismissRequest = onDismiss,
        scrollable = true,
        title = { Text(entry.name, style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (error != null) {
                    Text(
                        error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
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
                if (entry.tags.isNotEmpty()) {
                    DetailRow("标签", entry.tags.joinToString(" ") { "#$it" })
                }
                entry.url?.takeIf { it.isNotBlank() }?.let { DetailRow("网址", it) }
                entry.notes?.takeIf { it.isNotBlank() }?.let { DetailRow("备注", it) }
                entry.extras.forEach { (key, value) -> DetailRow(key, value) }
                Row(modifier = Modifier.padding(top = 4.dp)) {
                    QuietButton(text = "删除", icon = Icons.Filled.DeleteOutline, danger = true, onClick = onDelete)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onEdit) { Text("编辑") }
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

/**
 * One form for both modes. [initial] is null when adding; otherwise the fields are pre-filled
 * and the password stays blank, because an empty password means "keep the stored one".
 */
@Composable
private fun AccountFormDialog(
    initial: AccountEntry?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String?, String, String, String, List<String>, Map<String, String>) -> Unit,
) {
    var name by remember(initial) { mutableStateOf(initial?.name ?: "") }
    var username by remember(initial) { mutableStateOf(initial?.username ?: "") }
    var password by remember(initial) { mutableStateOf("") }
    var category by remember(initial) { mutableStateOf(initial?.category ?: "") }
    var url by remember(initial) { mutableStateOf(initial?.url ?: "") }
    var notes by remember(initial) { mutableStateOf(initial?.notes ?: "") }
    var tags by remember(initial) { mutableStateOf(initial?.tags?.joinToString(", ") ?: "") }
    var extras by remember(initial) {
        mutableStateOf(initial?.extras?.entries?.joinToString("\n") { "${it.key}=${it.value}" } ?: "")
    }

    val parsedTags = tags.split(",", "，").map { it.trim() }.filter { it.isNotEmpty() }
    val parsedExtras = extras.lines()
        .mapNotNull { line ->
            val at = line.indexOf('=')
            if (at <= 0) null else line.substring(0, at).trim() to line.substring(at + 1).trim()
        }
        .filter { it.first.isNotEmpty() && it.second.isNotEmpty() }
        .toMap()

    AppDialog(
        onDismissRequest = onDismiss,
        scrollable = true,
        title = {
            Text(if (initial == null) "新增账号" else "编辑账号", style = MaterialTheme.typography.titleLarge)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AppTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = "名称（必填）",
                    placeholder = "GitHub / 小红书-品牌号",
                    singleLine = true,
                )
                AppTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = "账号",
                    placeholder = "me@example.com / 13800138000",
                    singleLine = true,
                )
                SecretTextField(
                    value = password,
                    onValueChange = { password = it },
                    placeholder = if (initial == null) "密码" else "密码（留空则不修改）",
                )
                AppTextField(
                    value = category,
                    onValueChange = { category = it },
                    label = "分类",
                    placeholder = "留空归入「未分类」",
                    singleLine = true,
                )
                AppTextField(
                    value = tags,
                    onValueChange = { tags = it },
                    label = "标签（逗号分隔）",
                    placeholder = "小红书, 美妆, A组",
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
                AppTextField(
                    value = extras,
                    onValueChange = { extras = it },
                    label = "自定义字段（每行 键=值）",
                    placeholder = "绑定邮箱=op@example.com\n负责人=小王",
                    minLines = 3,
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
                        category.trim(),
                        url.trim(),
                        notes.trim(),
                        parsedTags,
                        parsedExtras,
                    )
                },
            ) { Text(if (busy) "保存中…" else "保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
