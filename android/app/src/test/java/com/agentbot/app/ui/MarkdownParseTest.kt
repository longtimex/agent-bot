package com.agentbot.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The first tests on the Android side. Only pure parsing is covered here: it needs no
 * device, no Robolectric and no Compose runtime, so `gradle :app:testDebugUnitTest` can
 * run it on the same CI runner that builds the APK.
 *
 * Assertions stay deliberately loose — the exact spacing of a fenced block or the depth
 * number of a nested bullet is an implementation detail, while "the code body survived"
 * and "the language tag survived" are the behaviour the chat relies on.
 */
class MarkdownParseTest {
    @Test
    fun emptySourceProducesNoSegments() {
        assertTrue(parseMarkdown("").isEmpty())
        assertTrue(parseMarkdown("   \n\n").isEmpty())
    }

    @Test
    fun fencedCodeKeepsItsBodyAndLanguage() {
        val segments = parseMarkdown("```kotlin\nval x = 1\n```")
        val code = segments.filterIsInstance<MdSegment.Code>().single()
        assertEquals("kotlin", code.language)
        assertTrue("the code body must survive parsing", code.code.contains("val x = 1"))
    }

    @Test
    fun plainTextBecomesATextSegment() {
        val segments = parseMarkdown("hello world")
        assertTrue(segments.isNotEmpty())
        assertTrue(segments.first() is MdSegment.Text)
    }

    @Test
    fun bulletsAreRecognisedWithADepth() {
        val segments = parseMarkdown("- one\n  - two")
        val bullets = segments.filterIsInstance<MdSegment.Bullet>()
        assertEquals(2, bullets.size)
        assertTrue("the outer bullet sits at depth 0", bullets[0].depth == 0)
        assertTrue("the indented bullet sits deeper", bullets[1].depth > bullets[0].depth)
    }
}
