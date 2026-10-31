package com.agentbot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentbot.app.ui.theme.Accent
import com.agentbot.app.ui.theme.TextSecondary
import kotlinx.coroutines.delay

/** A chat reply split into prose, list items, quotes and fenced code blocks. */
sealed interface MdSegment {
    data class Text(val spans: AnnotatedString) : MdSegment
    data class Code(val code: String, val language: String?) : MdSegment
    data class Bullet(val marker: String, val spans: AnnotatedString, val depth: Int) : MdSegment
    data class Quote(val spans: AnnotatedString) : MdSegment
}

private val FENCE = Regex("(?m)^```([A-Za-z0-9_+#.-]*)[ \\t]*\\n([\\s\\S]*?)(?:\\n^```[ \\t]*$|$)")
private val HEADING = Regex("^(#{1,4})\\s+(.*)$")
private val BULLET = Regex("""^([ \t]*)[-*+][ \t]+(.*)$""")
private val ORDERED = Regex("""^([ \t]*)(\d{1,3})[.)][ \t]+(.*)$""")
private val QUOTE = Regex("""^[ \t]*>[ \t]?(.*)$""")

/**
 * Inline tokens in priority order: [label](url), **bold**, ~~strike~~, `code`,
 * bare URLs, *italic*, _italic_. Groups map to one token each. URLs only take
 * ASCII URI characters so trailing CJK prose is not swallowed.
 */
private val INLINE = Regex(
    """\[([^\]\n]+)]\(((?:https?://)[A-Za-z0-9\-._~:/?#@!\x24&*+,;=%]+)\)""" +
        """|(\*\*[^*\n]+\*\*)""" +
        """|(~~[^~\n]+~~)""" +
        """|(`[^`\n]+`)""" +
        """|(https?://[A-Za-z0-9\-._~:/?#@!\x24&*+,;=%]+)""" +
        """|(\*[^*\s][^*\n]*\*)""" +
        """|((?<![A-Za-z0-9])_[^_\s][^_\n]*_(?![A-Za-z0-9]))""",
)

private val LinkColor = Color(0xFF8AB4F8)
private val LinkStyles = TextLinkStyles(
    style = SpanStyle(color = LinkColor, textDecoration = TextDecoration.Underline),
)

private val TRAILING_PUNCT = charArrayOf('.', ',', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？')

private fun AnnotatedString.Builder.appendLink(label: String, url: String) {
    val start = length
    append(label)
    addLink(LinkAnnotation.Url(url, LinkStyles), start, length)
}

/**
 * Minimal markdown for agent replies: fenced code blocks, inline code, bold,
 * italic, strikethrough, links, headings, lists and blockquotes. Tables stay
 * plain text — good enough for chat, far cheaper than a full renderer.
 */
fun parseMarkdown(source: String): List<MdSegment> {
    val segments = mutableListOf<MdSegment>()
    var cursor = 0
    for (match in FENCE.findAll(source)) {
        if (match.range.first > cursor) {
            parseText(source.substring(cursor, match.range.first), segments)
        }
        segments += MdSegment.Code(match.groupValues[2].removeSuffix("\n"), match.groupValues[1].takeIf { it.isNotBlank() })
        cursor = match.range.last + 1
    }
    if (cursor < source.length) {
        parseText(source.substring(cursor), segments)
    }
    return segments
}

/** Splits prose into paragraphs, list items and quotes; fenced code never reaches here. */
private fun parseText(chunk: String, out: MutableList<MdSegment>) {
    val lines = chunk.split("\n")
    val para = mutableListOf<String>()
    var quote: MutableList<String>? = null

    fun flushPara() {
        while (para.isNotEmpty() && para.last().isBlank()) para.removeAt(para.lastIndex)
        if (para.isNotEmpty()) out += MdSegment.Text(inlineMarkdown(para.joinToString("\n")))
        para.clear()
    }

    fun flushQuote() {
        quote?.let { q ->
            while (q.isNotEmpty() && q.last().isBlank()) q.removeAt(q.lastIndex)
            if (q.isNotEmpty()) out += MdSegment.Quote(inlineMarkdown(q.joinToString("\n")))
        }
        quote = null
    }

    for (line in lines) {
        val quoted = QUOTE.find(line)
        val bullet = BULLET.find(line)
        val ordered = ORDERED.find(line)
        when {
            quoted != null -> {
                flushPara()
                val target = quote ?: mutableListOf<String>().also { quote = it }
                target += quoted.groupValues[1]
            }
            bullet != null -> {
                flushPara()
                flushQuote()
                out += MdSegment.Bullet("•", inlineMarkdown(bullet.groupValues[2]), indentDepth(bullet.groupValues[1]))
            }
            ordered != null -> {
                flushPara()
                flushQuote()
                out += MdSegment.Bullet(
                    ordered.groupValues[2] + ".",
                    inlineMarkdown(ordered.groupValues[3]),
                    indentDepth(ordered.groupValues[1]),
                )
            }
            else -> {
                flushQuote()
                para += line
            }
        }
    }
    flushPara()
    flushQuote()
}

private fun indentDepth(leading: String): Int {
    var spaces = 0
    for (ch in leading) spaces += if (ch == '\t') 2 else 1
    return (spaces / 2).coerceAtMost(3)
}

/** Applies inline styling (bold/italic/code/strike/links) and turns headings into bold lines. */
fun inlineMarkdown(source: String): AnnotatedString = buildAnnotatedString {
    val lines = source.split("\n")
    lines.forEachIndexed { index, line ->
        val heading = HEADING.find(line)
        if (heading != null) {
            pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 17.sp))
            appendInline(heading.groupValues[2])
            pop()
        } else {
            appendInline(line)
        }
        if (index < lines.lastIndex) append("\n")
    }
}

private fun AnnotatedString.Builder.appendInline(line: String) {
    var last = 0
    for (match in INLINE.findAll(line)) {
        val start = match.range.first
        append(line.substring(last, start))
        val g = match.groupValues
        var end = match.range.last + 1
        when {
            g[1].isNotEmpty() && g[2].isNotEmpty() -> appendLink(g[1], g[2])
            g[3].isNotEmpty() -> styled(SpanStyle(fontWeight = FontWeight.Bold), g[3].substring(2, g[3].length - 2))
            g[4].isNotEmpty() -> styled(SpanStyle(textDecoration = TextDecoration.LineThrough), g[4].substring(2, g[4].length - 2))
            g[5].isNotEmpty() -> styled(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp), g[5].substring(1, g[5].length - 1))
            g[6].isNotEmpty() -> {
                val url = g[6].trimEnd(*TRAILING_PUNCT)
                end = start + url.length
                appendLink(url, url)
            }
            g[7].isNotEmpty() -> styled(SpanStyle(fontStyle = FontStyle.Italic), g[7].substring(1, g[7].length - 1))
            g[8].isNotEmpty() -> styled(SpanStyle(fontStyle = FontStyle.Italic), g[8].substring(1, g[8].length - 1))
        }
        last = end
    }
    append(line.substring(last))
}

private fun AnnotatedString.Builder.styled(style: SpanStyle, text: String) {
    pushStyle(style)
    append(text)
    pop()
}

/** Renders parsed markdown; assistant replies route through this. */
@Composable
fun MarkdownText(source: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        for (segment in parseMarkdown(source)) {
            when (segment) {
                is MdSegment.Text -> Text(
                    segment.spans,
                    color = MaterialTheme.colorScheme.onBackground,
                    style = MaterialTheme.typography.bodyLarge,
                )
                is MdSegment.Code -> CodeBlock(segment)
                is MdSegment.Bullet -> ListRow(segment)
                is MdSegment.Quote -> QuoteBlock(segment)
            }
        }
    }
}

@Composable
private fun ListRow(item: MdSegment.Bullet) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = (item.depth * 12).dp, top = 1.dp),
    ) {
        Text(
            item.marker,
            color = TextSecondary,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(end = 8.dp),
        )
        Text(
            item.spans,
            color = MaterialTheme.colorScheme.onBackground,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun QuoteBlock(quote: MdSegment.Quote) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .padding(vertical = 2.dp),
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(Accent.copy(alpha = 0.45f), RoundedCornerShape(2.dp)),
        )
        Text(
            quote.spans,
            color = TextSecondary,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(start = 10.dp),
        )
    }
}

@Composable
private fun CodeBlock(segment: MdSegment.Code) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(segment.code) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                segment.language ?: "代码",
                fontSize = 11.sp,
                color = TextSecondary,
                modifier = Modifier.weight(1f),
            )
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable {
                        clipboard.setText(AnnotatedString(segment.code))
                        copied = true
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                    contentDescription = "复制代码",
                    tint = if (copied) Accent else TextSecondary,
                    modifier = Modifier.size(13.dp),
                )
                Text(
                    if (copied) "已复制" else "复制",
                    fontSize = 11.sp,
                    color = if (copied) Accent else TextSecondary,
                    modifier = Modifier.padding(start = 4.dp),
                )
            }
        }
        Text(
            segment.code,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 19.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
}
