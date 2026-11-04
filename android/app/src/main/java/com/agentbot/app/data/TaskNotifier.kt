package com.agentbot.app.data

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.agentbot.app.MainActivity
import com.agentbot.app.R

/** Posts "task finished" notifications for tasks that settle while the app is in the background. */
object TaskNotifier {
    private const val CHANNEL_ID = "task_updates"
    const val EXTRA_OPEN_CHAT = "com.agentbot.app.OPEN_CHAT"
    const val EXTRA_TASK_ID = "com.agentbot.app.TASK_ID"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "任务通知", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "任务完成、失败或停止时提醒"
            },
        )
    }

    @SuppressLint("MissingPermission")
    fun taskSettled(context: Context, task: Task) {
        if (!allowed(context)) return
        ensureChannel(context)
        val title = when (task.status) {
            "done" -> "任务完成"
            "failed" -> "任务失败"
            else -> "任务已停止"
        }
        val body = when (task.status) {
            "done" -> task.reply?.takeIf { it.isNotBlank() } ?: task.text
            "failed" -> task.error?.takeIf { it.isNotBlank() } ?: "任务执行失败"
            else -> task.text
        }
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN_CHAT, true)
            .putExtra(EXTRA_TASK_ID, task.id)
        // Distinct request codes so each task notification keeps its own task id.
        val pending = PendingIntent.getActivity(
            context,
            task.id.hashCode() and 0x7fffffff,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_task)
            .setContentTitle(title)
            .setContentText(body.take(140))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(1000)))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context).notify(task.id.hashCode() and 0x7fffffff, notification)
    }

    private fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }
}
