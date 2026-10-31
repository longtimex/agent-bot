package com.agentbot.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Grok-inspired near-black palette
val Bg = Color(0xFF0B0C0E)
val Surface = Color(0xFF141518)
val SurfaceHigh = Color(0xFF1D1F23)
val BubbleUser = Color(0xFF26282D)
val Accent = Color(0xFF8AB4F8)
val TextPrimary = Color(0xFFE8EAED)
val TextSecondary = Color(0xFF9AA0A6)
val ErrorSoft = Color(0xFFF28B82)
val OkGreen = Color(0xFF81C995)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0B0C0E),
    background = Bg,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceHigh,
    onSurfaceVariant = TextSecondary,
    error = ErrorSoft,
)

private val AppTypography = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
)

@Composable
fun AgentBotTheme(content: @Composable () -> Unit) {
    // A terminal-adjacent tool: dark first, always
    MaterialTheme(colorScheme = DarkColors, typography = AppTypography, content = content)
}
