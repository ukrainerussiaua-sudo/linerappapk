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

## What the Android build does

- No Liner account or server: the app starts signed in as a local guest.
- Search, albums, artists, playlists and playback come from JioSaavn (client side).
- Lyrics: lyrics.geeked.wtf (word-by-word) and lrclib.net (line synced), shown in the
  unchanged Liner lyrics view.
- Likes, saved albums/artists, own playlists and history are stored on the device.
- Download = "Save" on a track: audio, cover and lyrics go to app storage for offline play.
- Removed: overlay, Discord, auto-update, local file import, system media controls.

JioSaavn can be blocked in some countries: if search is empty, try a VPN.
