# Liner for Android (personal build)

Personal, non-commercial build only (see LICENSE). Keep the GitHub repository PRIVATE
and do not share the APK.

## Get the APK (no PC tools needed)

1. Create a **private** repository on GitHub (e.g. `liner-android`).
2. Upload everything from this folder to it (see the guide in chat), branch `main`.
3. Open the repo -> **Actions** -> **Build Android APK** -> wait for the green check
   (about 5-8 minutes). If it did not start by itself, press **Run workflow**.
4. Open the finished run -> **Artifacts** -> download `Liner-debug-apk` (a zip),
   unzip it to get `app-debug.apk`.
5. Copy the APK to the tablet, open it, allow "install from this source".

## Build locally instead

Needs Node 22, pnpm 10, JDK 21 and Android Studio / Android SDK:

    pnpm install
    pnpm android:sync
    cd android && ./gradlew assembleDebug

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## What works / what does not

Works: sign-in, library, search, streaming, synced lyrics (if the API accepts the
WebView client).
Removed on Android: local file import, saved/offline tracks, overlay, Discord,
auto-update, YouTube fallback needing the Electron layer, system media notification.
Playback may stop when the screen is off (WebView limitation).
