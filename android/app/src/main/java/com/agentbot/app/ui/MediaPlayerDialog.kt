package com.agentbot.app.ui

import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File

/**
 * Plays reply voice notes and videos inside the App. The previous implementation handed
 * every non-image reply to ACTION_VIEW, so a phone without a video player showed a share
 * sheet (or nothing), which looked exactly like "the App cannot receive media".
 */
@Composable
fun MediaPlayerDialog(
    file: File,
    mime: String,
    title: String,
    onOpenExternal: () -> Unit,
    onDismiss: () -> Unit,
) {
    var playbackError by remember(file) { mutableStateOf<String?>(null) }
    val showPlaybackError = {
        playbackError = "无法播放此媒体，可能是编码不受支持或文件已损坏。请尝试右上角「用其他应用打开」。"
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            color = Color.Black.copy(alpha = 0.96f),
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Text(
                        title,
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                    )
                    IconButton(onClick = onOpenExternal) {
                        Icon(Icons.Filled.OpenInNew, contentDescription = "用其他应用打开", tint = Color.White)
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = "关闭", tint = Color.White)
                    }
                }
                playbackError?.let { message ->
                    InlineNotice(
                        text = message,
                        tone = MaterialTheme.colorScheme.error,
                        icon = Icons.Filled.Info,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                if (mime.startsWith("video/", ignoreCase = true)) {
                    VideoPane(file, showPlaybackError)
                } else {
                    AudioPane(file, title, showPlaybackError)
                }
            }
        }
    }
}

@Composable
private fun VideoPane(file: File, onError: () -> Unit) {
    var videoView by remember { mutableStateOf<VideoView?>(null) }
    DisposableEffect(file) {
        onDispose {
            runCatching { videoView?.stopPlayback() }
            videoView = null
        }
    }
    AndroidView(
        factory = { ctx ->
            VideoView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                val controller = MediaController(ctx)
                controller.setAnchorView(this)
                setMediaController(controller)
                setVideoPath(file.absolutePath)
                setOnPreparedListener { player ->
                    player.isLooping = false
                    start()
                }
                setOnErrorListener { _, _, _ ->
                    onError()
                    true
                }
                videoView = this
            }
        },
        update = { view ->
            if (view.tag != file.absolutePath) {
                view.tag = file.absolutePath
                view.setVideoPath(file.absolutePath)
                view.start()
            }
        },
        modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black),
    )
}

@Composable
private fun AudioPane(file: File, title: String, onError: () -> Unit) {
    val context = LocalContext.current
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var ready by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableStateOf(0) }
    var duration by remember { mutableStateOf(0) }
    val handler = remember { Handler(Looper.getMainLooper()) }

    fun release() {
        runCatching { player?.release() }
        player = null
        playing = false
    }

    DisposableEffect(file) {
        val mp = MediaPlayer()
        val prepared = runCatching {
            mp.setDataSource(context, android.net.Uri.fromFile(file))
            mp.setOnPreparedListener {
                duration = it.duration.coerceAtLeast(0)
                ready = true
                it.start()
                playing = true
            }
            mp.setOnCompletionListener { completed ->
                // Leave the playhead at the end so the next tap seeks to 0 and replays,
                // rather than calling start() at EOS (which does nothing on some devices).
                position = duration
                playing = false
                runCatching { completed.seekTo(0) }
            }
            mp.setOnErrorListener { _, _, _ ->
                ready = false
                playing = false
                onError()
                true
            }
            mp.prepareAsync()
        }.isSuccess
        if (prepared) {
            player = mp
        } else {
            runCatching { mp.release() }
            onError()
        }
        val tick = object : Runnable {
            override fun run() {
                player?.let {
                    position = runCatching { it.currentPosition }.getOrDefault(position)
                    duration = runCatching { it.duration }.getOrDefault(duration).coerceAtLeast(0)
                }
                handler.postDelayed(this, 400)
            }
        }
        handler.post(tick)
        onDispose {
            handler.removeCallbacks(tick)
            release()
        }
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier.fillMaxSize().padding(32.dp),
    ) {
        Surface(shape = CircleShape, color = Color.White.copy(alpha = 0.12f)) {
            IconButton(
                onClick = {
                    val mp = player ?: return@IconButton
                    if (playing) {
                        runCatching { mp.pause() }
                        playing = false
                    } else {
                        // start() at EOS is a no-op on several Android players; rewind first.
                        if (position > 0 && position >= duration) runCatching { mp.seekTo(0) }
                        runCatching { mp.start() }
                        playing = true
                    }
                },
                enabled = ready && player != null,
                modifier = Modifier.width(72.dp),
            ) {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "暂停" else "播放",
                    tint = Color.White,
                )
            }
        }
        Spacer(modifier = Modifier.padding(top = 24.dp))
        Text(title, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis)
        LinearProgressIndicator(
            progress = { if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f },
            color = MaterialTheme.colorScheme.primary,
            trackColor = Color.White.copy(alpha = 0.2f),
            modifier = Modifier.fillMaxWidth().padding(top = 22.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(formatClock(position), color = Color.White.copy(alpha = 0.7f))
            Text(formatClock(duration), color = Color.White.copy(alpha = 0.7f))
        }
    }
}

private fun formatClock(ms: Int): String {
    val total = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(total / 60, total % 60)
}
