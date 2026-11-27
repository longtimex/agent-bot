package com.agentbot.app.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
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

/**
 * One size label for every attachment surface. The pre-send chip and the sent bubble describe
 * the same file, so rounding only one of them made a 34-byte note read `1KB` before sending and
 * `34B` afterwards. Small files stay exact; larger ones keep one decimal and never become
 * `0.0KB` just below the next unit.
 */
fun formatFileSize(bytes: Long): String = when {
    bytes < 0 -> "0B"
    bytes < 1_024 -> "${bytes}B"
    bytes < 1_024L * 1_024 -> "%.1fKB".format(bytes / 1_024.0)
    bytes < 1_024L * 1_024 * 1_024 -> "%.1fMB".format(bytes / (1_024.0 * 1_024.0))
    else -> "%.1fGB".format(bytes / (1_024.0 * 1_024 * 1_024))
}

/** Name and size of an attachment already sent with a chat message; bytes are not kept. */
@Serializable
data class SentAttachment(
    val name: String,
    val mime: String = "",
    val size: Long = 0,
) {
    val sizeLabel: String get() = formatFileSize(size)
}

/**
 * A text message written while the bot was unreachable. It waits on the phone and is sent, in
 * order, once the server answers again. Only messages the server certainly never received are
 * queued, so a resend can never start the same task twice.
 */
@Serializable
data class OutboxEntry(
    val id: String,
    val prompt: String,
    val engine: String? = null,
    val model: String? = null,
    val at: Long,
)

/** Copies content URIs (photo picker, document picker) into private cache files, and persists chat history locally. */
object LocalStore {
    private val json = Json { ignoreUnknownKeys = true }

    fun read(context: Context, uri: Uri, fallbackName: String? = null): PendingAttachment {
        val resolver = context.contentResolver
        val name = queryDisplayName(resolver, uri) ?: fallbackName ?: "attachment.bin"
        val declaredMime = resolver.getType(uri)?.substringBefore(';')?.trim()?.takeIf { it.isNotBlank() }
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
        /** Set while the bubble is a message still waiting in the outbox. */
        val outboxId: String? = null,
        /** Names only: a 安全输入 card must survive a restart, its value is never stored. */
        val secretRequests: List<SecretRequest> = emptyList(),
        /** Stable per-bubble identity so Compose LazyColumn never hits duplicate timestamp keys. */
        val localId: String = "",
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
                outboxId = it.outboxId,
                secretRequests = it.secretRequests,
                localId = it.localId,
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

    // ---- offline outbox ----

    private val outboxSerializer = ListSerializer(OutboxEntry.serializer())

    /** apply() keeps the write order, so back-to-back queue changes never land out of sequence. */
    fun saveOutbox(context: Context, entries: List<OutboxEntry>) {
        val prefs = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE).edit()
        if (entries.isEmpty()) prefs.remove("chat_outbox") else prefs.putString("chat_outbox", json.encodeToString(outboxSerializer, entries))
        prefs.apply()
    }

    fun loadOutbox(context: Context): List<OutboxEntry> {
        val raw = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE).getString("chat_outbox", null) ?: return emptyList()
        return runCatching { json.decodeFromString(outboxSerializer, raw) }.getOrDefault(emptyList())
    }

    fun loadMessages(context: Context): List<com.agentbot.app.ui.ChatMessage> {
        val raw = context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .getString("chat_messages", null) ?: return emptyList()
        // Rows are decoded one at a time: a single unreadable entry — an out-of-range role from
        // an older build, say — used to empty the whole chat, and the next save then wrote that
        // emptiness over the history.
        val rows = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrNull() ?: return emptyList()
        val seenIds = mutableSetOf<String>()
        return rows.mapNotNull { element ->
            val stored = runCatching { json.decodeFromJsonElement(StoredMessage.serializer(), element) }.getOrNull()
                ?: return@mapNotNull null
            val role = com.agentbot.app.ui.ChatMessage.Role.entries.getOrNull(stored.role) ?: return@mapNotNull null
            val candidateId = stored.localId.takeIf { it.isNotBlank() && seenIds.add(it) }
                ?: java.util.UUID.randomUUID().toString().also { seenIds.add(it) }
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
                outboxId = stored.outboxId,
                secretRequests = stored.secretRequests,
                localId = candidateId,
            )
        }
    }

    private fun clearMessages(context: Context) {
        context.getSharedPreferences("agent_bot", Context.MODE_PRIVATE)
            .edit()
            .remove("chat_messages")
            .apply()
    }

    // ---- archived transcripts (历史会话) ----

    /**
     * The chat of a session parked by 新建会话, under the server's archive id. Files rather than
     * SharedPreferences: up to 20 of them would otherwise all be read back on every launch.
     */
    private fun archiveFile(context: Context, id: String): File? {
        // The id comes back from the server; anything but its own 12-hex shape is not a file name
        if (!ARCHIVE_ID.matches(id)) return null
        return File(File(context.filesDir, "session_archive").apply { mkdirs() }, "$id.json")
    }

    private val ARCHIVE_ID = Regex("^[0-9a-f]{12}$")

    fun archiveTranscript(context: Context, id: String, messages: List<com.agentbot.app.ui.ChatMessage>) {
        val file = archiveFile(context, id) ?: return
        if (messages.isEmpty()) return
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
                localId = it.localId,
            )
        }
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(json.encodeToString(stored))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    /**
     * Reads an archived transcript. The file stays: the entry stays listed after a resume, and the
     * live chat is written back over it the next time this conversation is parked.
     */
    fun takeTranscript(context: Context, id: String): List<com.agentbot.app.ui.ChatMessage> {
        val file = archiveFile(context, id) ?: return emptyList()
        if (!file.exists()) return emptyList()
        val rows = runCatching { json.parseToJsonElement(file.readText()).jsonArray }.getOrNull()
        val seenIds = mutableSetOf<String>()
        return rows?.mapNotNull { element ->
            val stored = runCatching { json.decodeFromJsonElement(StoredMessage.serializer(), element) }.getOrNull()
                ?: return@mapNotNull null
            val role = com.agentbot.app.ui.ChatMessage.Role.entries.getOrNull(stored.role) ?: return@mapNotNull null
            val candidateId = stored.localId.takeIf { it.isNotBlank() && seenIds.add(it) }
                ?: java.util.UUID.randomUUID().toString().also { seenIds.add(it) }
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
                localId = candidateId,
            )
        }.orEmpty()
    }

    fun hasTranscript(context: Context, id: String): Boolean = archiveFile(context, id)?.exists() == true

    /** Archived transcripts on this phone whose messages contain [query], for 历史会话 search. */
    fun transcriptsMatching(context: Context, ids: List<String>, query: String): Set<String> {
        val needle = query.trim()
        if (needle.isEmpty()) return emptySet()
        return ids.filter { id -> takeTranscript(context, id).any { it.text.contains(needle, ignoreCase = true) } }.toSet()
    }

    fun dropTranscript(context: Context, id: String) {
        archiveFile(context, id)?.delete()
    }

    /** Removes transcripts the server no longer lists (evicted past its 20-session cap). */
    fun pruneTranscripts(context: Context, keep: Set<String>) {
        val dir = File(context.filesDir, "session_archive")
        dir.listFiles()?.forEach { file ->
            val id = file.name.removeSuffix(".json")
            if (file.name.endsWith(".json") && id !in keep) file.delete()
        }
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
