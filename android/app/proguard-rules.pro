# Keep kotlinx.serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.agentbot.app.**$$serializer { *; }
-keepclassmembers class com.agentbot.app.** { *** Companion; }
-keepclasseswithmembers class com.agentbot.app.** { kotlinx.serialization.KSerializer serializer(...); }
