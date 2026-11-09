package com.agentbot.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// A quiet, terminal-adjacent palette: near-black canvas, layered charcoal, one cool accent.
val Bg = Color(0xFF0A0B0D)
val Surface = Color(0xFF141619)
val SurfaceHigh = Color(0xFF1C1F24)
val SurfaceLow = Color(0xFF101215)
val BubbleUser = Color(0xFF252931)
val Accent = Color(0xFF8AB4F8)
val AccentSoft = Color(0x1F8AB4F8)
val Border = Color(0xFF2A2E35)
val BorderStrong = Color(0xFF3A4049)
val TextPrimary = Color(0xFFE9ECF0)
val TextSecondary = Color(0xFF9AA2AD)
val ErrorSoft = Color(0xFFF28B82)
val WarningSoft = Color(0xFFFDD663)
val OkGreen = Color(0xFF81C995)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Bg,
    primaryContainer = Color(0xFF24364F),
    onPrimaryContainer = Color(0xFFD7E4FF),
    secondary = Color(0xFFA8C7FA),
    onSecondary = Bg,
    background = Bg,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceHigh,
    onSurfaceVariant = TextSecondary,
    surfaceContainerLowest = Bg,
    surfaceContainerLow = SurfaceLow,
    surfaceContainer = Surface,
    surfaceContainerHigh = SurfaceHigh,
    surfaceContainerHighest = Color(0xFF24282E),
    outline = Border,
    outlineVariant = Border,
    error = ErrorSoft,
    onError = Bg,
)

private val AppTypography = Typography(
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 31.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 10.sp, lineHeight = 14.sp, letterSpacing = 0.3.sp),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun AgentBotTheme(content: @Composable () -> Unit) {
    // A terminal-adjacent tool: dark first, always.
    MaterialTheme(
        colorScheme = DarkColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
