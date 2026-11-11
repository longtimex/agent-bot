import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.agentbot.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agentbot.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1002000
        versionName = "1.2.0"
    }

    // Release signing is supplied by CI (or a local keystore.properties file).
    // Debug builds keep their own key, which is why the two cannot overwrite
    // each other: switching a phone from a debug APK to this release APK needs
    // an uninstall first and loses local App settings.
    val keystoreProperties = Properties().apply {
        val file = rootProject.file("keystore.properties")
        if (file.exists()) FileInputStream(file).use { load(it) }
    }
    fun signingValue(env: String, key: String): String? =
        System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProperties.getProperty(key)?.takeIf { it.isNotBlank() }

    val releaseStoreFile = signingValue("ANDROID_KEYSTORE_PATH", "storeFile")
    val releaseStorePassword = signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
    val releaseKeyAlias = signingValue("ANDROID_KEY_ALIAS", "keyAlias")
    val releaseKeyPassword = signingValue("ANDROID_KEY_PASSWORD", "keyPassword")
    val releaseSigningConfigured =
        listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { it != null }

    // `file(...)` in an app module resolves against android/app, but operators
    // naturally write a path relative to android/ (the directory holding
    // keystore.properties). Resolve relative paths against the root project;
    // absolute paths from CI remain untouched.
    val releaseStore = releaseStoreFile?.let { rootProject.file(it) }

    signingConfigs {
        if (releaseSigningConfigured && releaseStore != null) {
            create("release") {
                storeFile = releaseStore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseSigningConfigured && releaseStore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
