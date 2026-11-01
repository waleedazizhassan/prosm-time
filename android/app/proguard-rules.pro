# PROSM Time - Android release hardening (R8 / ProGuard).
#
# minifyEnabled + shrinkResources are turned on for the release build in
# app/build.gradle. These rules keep the Capacitor bridge and every
# @JavascriptInterface / @PluginMethod entry point intact, so the app's
# behaviour is unchanged - only the compiled Java/Kotlin is renamed and
# stripped.

# --- Capacitor bridge and plugins ---
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep class net.prosm.time.** { *; }

# --- Cordova plugins bridged through Capacitor ---
-keep class org.apache.cordova.** { *; }

# --- Anything the WebView calls into ---
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- AndroidX / annotations ---
-keep class androidx.** { *; }
-dontwarn androidx.**
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# --- Strip developer conveniences from the release binary ---
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
}

# --- Hide original source file names in stack traces ---
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable

# --- Plugins and Firebase (2026-11-01, the Play build's R8) ---
-keep class com.equimaps.capacitor_background_geolocation.** { *; }
-keep class com.capacitorjs.plugins.** { *; }
-keep class ar.com.anura.plugins.backgroundmode.** { *; }
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**
