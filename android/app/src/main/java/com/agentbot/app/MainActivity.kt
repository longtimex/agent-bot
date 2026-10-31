package com.agentbot.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.core.content.IntentCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.agentbot.app.data.SettingsRepository
import com.agentbot.app.data.TaskNotifier
import com.agentbot.app.ui.AppDrawer
import com.agentbot.app.ui.AppViewModel
import com.agentbot.app.ui.AppVisibility
import com.agentbot.app.ui.ChatScreen
import com.agentbot.app.ui.HistoryScreen
import com.agentbot.app.ui.QueueScreen
import com.agentbot.app.ui.RemindersScreen
import com.agentbot.app.ui.Screen
import com.agentbot.app.ui.SchedulesScreen
import com.agentbot.app.ui.SessionScreen
import com.agentbot.app.ui.SettingsScreen
import com.agentbot.app.ui.StatusScreen
import com.agentbot.app.ui.theme.AgentBotTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val settings by lazy { SettingsRepository(this) }

    private val vm: AppViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                AppViewModel(settings, applicationContext) as T
        }
    }

    /** Skips the refresh on the very first onStart so launch doesn't fetch everything twice. */
    private var startedBefore = false

    override fun onStart() {
        super.onStart()
        AppVisibility.foreground = true
        if (startedBefore) vm.onForeground()
        startedBefore = true
    }

    override fun onStop() {
        AppVisibility.foreground = false
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openChatFromIntent(intent)
        handleShareIntent(intent)
    }

    private fun openChatFromIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(TaskNotifier.EXTRA_OPEN_CHAT, false) == true) {
            intent.removeExtra(TaskNotifier.EXTRA_OPEN_CHAT)
            val taskId = intent.getStringExtra(TaskNotifier.EXTRA_TASK_ID)
            intent.removeExtra(TaskNotifier.EXTRA_TASK_ID)
            if (taskId != null) vm.focusTask(taskId) else vm.navigate(Screen.Chat)
        }
    }

    /** Share sheet entry: text becomes the draft, streams become pending attachments. */
    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        } else {
            listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        }
        // Clear before handling so a redelivered intent cannot stage the same share twice.
        intent.removeExtra(Intent.EXTRA_TEXT)
        intent.removeExtra(Intent.EXTRA_STREAM)
        vm.acceptShare(this, text, uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openChatFromIntent(intent)
        handleShareIntent(intent)
        setContent {
            AgentBotTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val drawerState = rememberDrawerState(androidx.compose.material3.DrawerValue.Closed)
                    val snackbar = remember { SnackbarHostState() }
                    val screen = vm.screen
                    val toast = vm.toast
                    val scope = rememberCoroutineScope()

                    // Back closes the drawer or returns to chat instead of quitting.
                    BackHandler(enabled = drawerState.isOpen || screen != Screen.Chat) {
                        if (drawerState.isOpen) {
                            scope.launch { drawerState.close() }
                        } else {
                            vm.navigate(Screen.Chat)
                        }
                    }

                    LaunchedEffect(toast) {
                        if (toast != null) {
                            snackbar.showSnackbar(toast)
                            vm.consumeToast()
                        }
                    }
                    LaunchedEffect(Unit) {
                        if (settings.connection() != null) vm.refreshSession()
                    }

                    ModalNavigationDrawer(
                        drawerState = drawerState,
                        drawerContent = {
                            AppDrawer(
                                current = screen,
                                onNavigate = {
                                    drawerState.close()
                                    vm.navigate(it)
                                },
                                onNewChat = { vm.newChat() },
                            )
                        },
                    ) {
                        Scaffold(
                            containerColor = MaterialTheme.colorScheme.background,
                            snackbarHost = {
                                SnackbarHost(snackbar) { data ->
                                    Snackbar(
                                        snackbarData = data,
                                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                                        contentColor = MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            },
                        ) { padding ->
                            Box(modifier = Modifier.fillMaxSize().padding(padding)) {
                                when (screen) {
                                    Screen.Chat -> ChatScreen(vm = vm, onOpenDrawer = { drawerState.open() })
                                    Screen.History -> HistoryScreen(vm)
                                    Screen.Reminders -> RemindersScreen(vm)
                                    Screen.Schedules -> SchedulesScreen(vm)
                                    Screen.Session -> SessionScreen(vm)
                                    Screen.Queue -> QueueScreen(vm)
                                    Screen.Agents -> AgentsScreen(vm)
                                    Screen.Ops -> OpsScreen(vm)
                                    Screen.Proxy -> ProxyScreen(vm)
                                    Screen.Aliases -> AliasesScreen(vm)
                                    Screen.Access -> AccessScreen(vm)
                                    Screen.Models -> ModelsScreen(vm)
                                    Screen.Cc -> CcScreen(vm)
                                    Screen.Config -> ConfigScreen(vm)
                                    Screen.Status -> StatusScreen(vm)
                                    Screen.Help -> HelpScreen(vm)
                                    Screen.Settings -> SettingsScreen(vm, settings)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
