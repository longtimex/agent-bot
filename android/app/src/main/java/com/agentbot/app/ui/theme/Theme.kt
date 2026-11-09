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

// Grok-inspired: a quiet near-black canvas, warm neutral ink and one restrained light accent.
// The interface should feel like paper in a dark room rather than a saturated developer console.
val Bg = Color(0xFF0A0A0A)
val Surface = Color(0xFF121212)
val SurfaceHigh = Color(0xFF1B1B1C)
val SurfaceLow = Color(0xFF0E0E0F)
val SurfaceHighest = Color(0xFF232324)
val BubbleUser = Color(0xFF242424)
val Accent = Color(0xFFF2F1EC)
val AccentSoft = Color(0x14F2F1EC)
val Border = Color(0xFF29292B)
val BorderStrong = Color(0xFF3D3D40)
val TextPrimary = Color(0xFFF2F1EC)
val TextSecondary = Color(0xFFA2A19C)
val TextTertiary = Color(0xFF6F6F6B)
val ErrorSoft = Color(0xFFFF8D85)
val ErrorContainer = Color(0xFF3A1A18)
val WarningSoft = Color(0xFFE8C97A)
val OkGreen = Color(0xFF8CC99A)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Bg,
    primaryContainer = Color(0xFF2B2B2C),
    onPrimaryContainer = TextPrimary,
    secondary = TextSecondary,
    onSecondary = Bg,
    secondaryContainer = SurfaceHigh,
    onSecondaryContainer = TextPrimary,
    tertiary = Color(0xFFD7C7A8),
    onTertiary = Bg,
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
    surfaceContainerHighest = SurfaceHighest,
    outline = Border,
    outlineVariant = Border,
    error = ErrorSoft,
    onError = Bg,
    errorContainer = ErrorContainer,
    onErrorContainer = Color(0xFFFFDAD6),
)

private val AppTypography = Typography(
    headlineSmall = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 25.sp,
        lineHeight = 32.sp,
        letterSpacing = (-0.2).sp,
    ),
    titleLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp,
        lineHeight = 28.sp,
        letterSpacing = (-0.1).sp,
    ),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 23.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 10.sp, lineHeight = 14.sp, letterSpacing = 0.35.sp),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(9.dp),
    small = RoundedCornerShape(13.dp),
    medium = RoundedCornerShape(17.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(30.dp),
)

/** Four-pixel spacing ladder; screens should compose from these instead of ad-hoc values. */
object AppSpacing {
    val xxs = 4.dp
    val xs = 6.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 28.dp
    val screen = 20.dp
}

/** A deliberately small radius ladder keeps cards, fields and dialogs in one family. */
object AppRadius {
    val sm = 10.dp
    val md = 14.dp
    val lg = 20.dp
    val xl = 28.dp
    val pill = 999.dp
}

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
