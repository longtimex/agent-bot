package com.agentbot.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File

private val unsafeChars = Regex("[^A-Za-z0-9._-]")

/** Disk cache for reply media so images survive an app restart and re-downloads are avoided. */
internal object MediaCache {
    fun file(context: Context, taskId: String, index: Int, name: String): File {
        val dir = File(context.cacheDir, "media").apply { mkdirs() }
        val safeId = taskId.replace(unsafeChars, "_").takeLast(48).ifEmpty { "task" }
        val safeName = name.replace(unsafeChars, "_").takeLast(80).ifEmpty { "media" }
        return File(dir, "$safeId-$index-$safeName")
    }

    fun read(context: Context, taskId: String, index: Int, name: String): ByteArray? =
        file(context, taskId, index, name).takeIf { it.isFile }?.readBytes()

    fun write(context: Context, taskId: String, index: Int, name: String, bytes: ByteArray): File =
        file(context, taskId, index, name).also { it.writeBytes(bytes) }
}

/** Decodes a reply image, downsampling so huge screenshots cannot exhaust the heap. */
fun decodeMediaBitmap(bytes: ByteArray, maxDim: Int = 1600): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}

/** Best-effort MIME by extension; viewers pick the right handler from this. */
fun mediaMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "gif" -> "image/gif"
    "webp" -> "image/webp"
    "bmp" -> "image/bmp"
    "mp4" -> "video/mp4"
    "mov" -> "video/quicktime"
    "webm" -> "video/webm"
    "ogg", "oga", "opus" -> "audio/ogg"
    "mp3" -> "audio/mpeg"
    "m4a" -> "audio/mp4"
    "wav" -> "audio/wav"
    "pdf" -> "application/pdf"
    "zip" -> "application/zip"
    "apk" -> "application/vnd.android.package-archive"
    "txt", "md", "log", "json" -> "text/plain"
    else -> "application/octet-stream"
}
