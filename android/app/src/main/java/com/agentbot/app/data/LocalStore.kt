package com.agentbot.app.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.Base64

/** One attachment queued for the next message. Bytes stay in memory until send. */
@Serializable
data class PendingAttachment(
    val name: String,
    val mime: String,
    val base64: String,
) {
    val sizeBytes: Int get() = base64.length * 3 / 4
}

object AttachmentLimits {
    const val MAX_COUNT = 4
    const val MAX_TOTAL_BYTES = 15 * 1024 * 1024
}

/** Name and size of an attachment already sent with a chat message; bytes are not kept. */
@Serializable
data class SentAttachment(
    val name: String,
    val mime: String = "",
    val size: Int = 0,
) {
    val sizeLabel: String
        get() = when {
            size >= 1024 * 1024 -> "%.1fMB".format(size / 1024.0 / 1024.0)
            size >= 1024 -> "${(size + 1023) / 1024}KB"
            else -> "${size}B"
        }
}

/** Reads content URIs (photo picker, document picker) into PendingAttachments, and persists chat history locally. */
object LocalStore {
    private val json = Json { ignoreUnknownKeys = true }

    fun read(context: Context, uri: Uri, fallbackName: String? = null): PendingAttachment {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val name = queryDisplayName(resolver, uri) ?: fallbackName ?: "attachment.bin"
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("无法读取所选文件")
        val encoded = Base64.getEncoder().encodeToString(bytes)
        return PendingAttachment(name = name, mime = mime, base64 = encoded)
    }

    private fun queryDisplayName(resolver: android.content.ContentResolver, uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
        }
    }.getOrNull()

    // ---- chat history persistence ----

    @Serializable
    private data class StoredMessage(
        val role: Int,
        val text: String,
        val taskId: String? = null,
        val status: String? = null,
        val at: Long,
        val media: List<TaskMedia> = emptyList(),
        val attachments: List<SentAttachment> = emptyList(),
    )

    fun saveMessages(context: Context, messages: List<com.agentbot.app.ui.ChatMessage>) {
        val stored = messages.map {
            StoredMessage(it.role.ordinal, it.text, it.taskId, it.status, it.at, it.media, it.attachments)
        }
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .putString("chat_messages", json.encodeToString(stored))
            .apply()
    }

    fun loadMessages(context: Context): List<com.agentbot.app.ui.ChatMessage> {
        val raw = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .getString("chat_messages", null) ?: return emptyList()
        return runCatching {
            json.decodeFromString<List<StoredMessage>>(raw).map {
                com.agentbot.app.ui.ChatMessage(
                    role = com.agentbot.app.ui.ChatMessage.Role.entries[it.role],
                    text = it.text,
                    taskId = it.taskId,
                    status = it.status,
                    at = it.at,
                    media = it.media,
                    attachments = it.attachments,
                )
            }
        }.getOrDefault(emptyList())
    }

    fun clearMessages(context: Context) {
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .remove("chat_messages")
            .apply()
    }

    // ---- unsent draft ----

    fun saveDraft(context: Context, text: String) {
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .putString("chat_draft", text)
            .apply()
    }

    fun loadDraft(context: Context): String =
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE).getString("chat_draft", "").orEmpty()
}
