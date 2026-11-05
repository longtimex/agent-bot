package com.agentbot.app.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import java.io.ByteArrayOutputStream
import java.io.InputStream
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

    /**
     * The server's own per-file ceiling (`MAX_ATTACH_FILE_BYTES`). A bigger file is not an error:
     * the bot answers with a note that it was not attached, so the user pays the upload and gets
     * no image. Refusing at pick time says the same thing before any bytes leave the phone.
     */
    const val MAX_FILE_BYTES = 10 * 1024 * 1024
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
        val limit = AttachmentLimits.MAX_FILE_BYTES
        // A picker hands over anything the user can see, and both the bytes and their Base64 land
        // on the heap: enforcing the limit only after readBytes() would kill the process on a
        // video or a disk image before the size was ever known. The cap is the server's own
        // per-file ceiling, so an oversized pick is refused with the reason instead of being
        // uploaded and then quietly left out of the prompt.
        querySize(resolver, uri)?.let { declared ->
            if (declared > limit) {
                throw IllegalStateException("$name 有 ${megabytes(declared)}，服务器单个附件最多 ${limit / 1024 / 1024}MB")
            }
        }
        val bytes = resolver.openInputStream(uri)?.use { readCapped(it, limit, name) }
            ?: throw IllegalStateException("无法读取所选文件")
        // An empty file encodes to an empty data field, and the server rejects the whole request
        // over it ("附件缺少 name 或 data") — so one undownloaded cloud placeholder used to fail
        // every later send too, because a failed send keeps its attachments staged.
        if (bytes.isEmpty()) throw IllegalStateException("$name 是空的，服务器不会接收空附件")
        val encoded = Base64.getEncoder().encodeToString(bytes)
        return PendingAttachment(name = name, mime = mime, base64 = encoded)
    }

    private fun megabytes(bytes: Long): String = "%.1fMB".format(bytes / 1024.0 / 1024.0)

    /** Declared length from the provider, or null when it withholds one (some cloud providers do). */
    private fun querySize(resolver: android.content.ContentResolver, uri: Uri): Long? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (index < 0 || !cursor.moveToFirst() || cursor.isNull(index)) null else cursor.getLong(index)
        }
    }.getOrNull()?.takeIf { it > 0 }

    /** Streaming read that gives up at the limit, for the case where the provider declares no size. */
    private fun readCapped(input: InputStream, limit: Int, name: String): ByteArray {
        val out = ByteArrayOutputStream(minOf(limit, 256 * 1024))
        val buffer = ByteArray(64 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > limit) throw IllegalStateException("$name 超过 ${limit / 1024 / 1024}MB 上限")
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
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

    /**
     * Whole-history budget. SharedPreferences reads the value back in full on first access and
     * keeps it in memory, so an unbounded chat eventually costs launch time and heap — the newest
     * bubbles are worth more to the user than the oldest, so the tail is what gets dropped.
     */
    private const val MAX_HISTORY_BYTES = 2 * 1024 * 1024

    private fun saveMessages(context: Context, messages: List<com.agentbot.app.ui.ChatMessage>) {
        val stored = messages.map {
            StoredMessage(it.role.ordinal, it.text, it.taskId, it.status, it.at, it.media, it.attachments)
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
