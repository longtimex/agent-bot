package com.agentbot.app.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import java.io.File

/** One attachment queued for the next message. The picked file stays on disk until send. */
@Serializable
data class PendingAttachment(
    val name: String,
    val mime: String,
    /** Absolute path in the app cache; uploading streams it instead of loading it into the heap. */
    val path: String,
    val sizeBytes: Long,
) {
    val file: File get() = File(path)
}

object AttachmentLimits {
    const val MAX_COUNT = 4
}

/** Name and size of an attachment already sent with a chat message; bytes are not kept. */
@Serializable
data class SentAttachment(
    val name: String,
    val mime: String = "",
    val size: Long = 0,
) {
    val sizeLabel: String
        get() = when {
            size >= 1024 * 1024 -> "%.1fMB".format(size / 1024.0 / 1024.0)
            size >= 1024 -> "${(size + 1023) / 1024}KB"
            else -> "${size}B"
        }
}

/** Copies content URIs (photo picker, document picker) into private cache files, and persists chat history locally. */
object LocalStore {
    private val json = Json { ignoreUnknownKeys = true }

    fun read(context: Context, uri: Uri, fallbackName: String? = null): PendingAttachment {
        val resolver = context.contentResolver
        val name = queryDisplayName(resolver, uri) ?: fallbackName ?: "attachment.bin"
        val declaredMime = resolver.getType(uri)?.takeIf { it.isNotBlank() }
        // Some document providers answer null or application/octet-stream for a perfectly
        // ordinary .mp4/.m4a. Trusting that makes the server treat it as an opaque file,
        // so fall back to the extension before classifying the attachment.
        val mime = when {
            declaredMime != null && declaredMime != "application/octet-stream" -> declaredMime
            else -> mediaMime(name).takeIf { it != "application/octet-stream" } ?: declaredMime ?: "application/octet-stream"
        }
        // Keep the picked file on disk. Reading it into a ByteArray (and then Base64)
        // made a large video consume several times its size in the phone heap before
        // the upload even started. The network layer streams this file instead.
        val dir = File(context.cacheDir, "pending_attachments").apply { mkdirs() }
        val target = File.createTempFile("picked-", ".bin", dir)
        try {
            resolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
            } ?: throw IllegalStateException("无法读取所选文件")
            if (target.length() == 0L) {
                throw IllegalStateException("$name 是空的，服务器不会接收空附件")
            }
            return PendingAttachment(name = name, mime = mime, path = target.absolutePath, sizeBytes = target.length())
        } catch (err: Exception) {
            target.delete()
            throw err
        }
    }

    /** Deletes the cached copy behind a sent or discarded attachment. */
    fun discard(attachment: PendingAttachment) {
        runCatching { attachment.file.delete() }
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
        val errorCode: String? = null,
        val engineNote: String? = null,
        val at: Long,
        val media: List<TaskMedia> = emptyList(),
        val attachments: List<SentAttachment> = emptyList(),
    )

    /**
     * Whole-history budget. SharedPreferences reads the value back in full on first access and
     * keeps it in memory, so an unbounded chat eventually costs launch time and heap — the newest
     * bubbles are worth more to the user than the oldest, so the tail is what gets dropped.
     */
    private const val MAX_HISTORY_BYTES = 2 * 1024 * 1024

    private fun saveMessages(context: Context, messages: List<com.agentbot.app.ui.ChatMessage>) {
        val stored = messages.map {
            StoredMessage(
                it.role.ordinal,
                it.text,
                it.taskId,
                it.status,
                it.errorCode,
                it.engineNote,
                it.at,
                it.media,
                it.attachments,
            )
        }
        val encoded = stored.map { json.encodeToString(StoredMessage.serializer(), it) }
        // Walk from the newest row backwards and stop where the budget runs out. The newest row is
        // always kept, however oversized, so the answer the user is reading survives its own write.
        var bytes = 0
        var from = 0
        for (index in stored.indices.reversed()) {
            bytes += encoded[index].length + 1
            if (index < stored.lastIndex && bytes > MAX_HISTORY_BYTES) {
                from = index + 1
                break
            }
        }
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .putString("chat_messages", json.encodeToString(stored.subList(from, stored.size)))
            .apply()
    }

    /**
     * The one history write the UI calls. An empty chat removes the key instead of storing `[]`,
     * which is what 新建会话 asked for; routing both through here keeps the removal ordered against
     * the trailing writes.
     */
    fun writeHistory(context: Context, messages: List<com.agentbot.app.ui.ChatMessage>) {
        if (messages.isEmpty()) clearMessages(context) else saveMessages(context, messages)
    }

    fun loadMessages(context: Context): List<com.agentbot.app.ui.ChatMessage> {
        val raw = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .getString("chat_messages", null) ?: return emptyList()
        // Rows are decoded one at a time: a single unreadable entry — an out-of-range role from
        // an older build, say — used to empty the whole chat, and the next save then wrote that
        // emptiness over the history.
        val rows = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrNull() ?: return emptyList()
        return rows.mapNotNull { element ->
            val stored = runCatching { json.decodeFromJsonElement(StoredMessage.serializer(), element) }.getOrNull()
                ?: return@mapNotNull null
            val role = com.agentbot.app.ui.ChatMessage.Role.entries.getOrNull(stored.role) ?: return@mapNotNull null
            com.agentbot.app.ui.ChatMessage(
                role = role,
                text = stored.text,
                taskId = stored.taskId,
                status = stored.status,
                errorCode = stored.errorCode,
                engineNote = stored.engineNote,
                at = stored.at,
                media = stored.media,
                attachments = stored.attachments,
            )
        }
    }

    private fun clearMessages(context: Context) {
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
