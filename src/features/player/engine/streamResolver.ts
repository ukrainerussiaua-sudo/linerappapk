<<<<<<< HEAD
=======
import { isAndroidApp } from "@/platform/android/native";
import { downloadAudioBlob } from "@/platform/android/androidFetch";
>>>>>>> e9cee71 (youtube music + soundcloud)
import { isSaavnId } from "@/platform/android/saavn/saavnApi";
import { resolveSaavnStream } from "@/platform/android/saavn/saavnStream";
import {
  isYoutubeSignedIn,
  prefersAccountPlayback,
  resolveDirectAudioStream,
  openTvAudioStream,
  resolveTvAudioStream,
  toVideoId,
} from "@/shared/youtube";
import {
  isOfflineMode,
  OFFLINE_UNAVAILABLE_MESSAGE,
} from "@/features/connectivity/store/offlineModeStore";
import {
  resolveSoundCloudStream,
  toSoundCloudTrackId,
} from "@/shared/media/soundcloud";
import { resolveLinerStream } from "@/shared/media/liner/linerPlayback";
import { isLocalTrackId, localTrackAudioUrl } from "@/shared/media/local";
import { savedAudioUrl, savedTrackRecord } from "@/shared/media/saved";
import { isAbortError } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import { rememberStreamOrigin } from "./nowPlayingLog";
import {
  fromInnertubeStream,
  fromLinerStream,
  fromSoundCloudStream,
  fromTvProgressiveStream,
  fromTvStream,
  type PlayableTrack,
  type PlaybackStream,
} from "./playbackStream";
import { findYoutubeStandIn } from "./youtubeStandIn";
import { findExactSongVersion } from "./exactSongVersion";
import { appAllowsAccountPlayback } from "./accountPlayback";

export interface ResolveStreamOptions {
  progressive?: boolean;
}

export type {
  BufferedPlaybackStream,
  PlayableTrack,
  PlaybackStream,
  UrlPlaybackStream,
} from "./playbackStream";

async function resolveTvAudio(
  videoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  if (progressive)
    return fromTvProgressiveStream(
      await openTvAudioStream(videoId, { signal }),
    );
  return fromTvStream(await resolveTvAudioStream(videoId, { signal }));
}

async function resolveYoutubeAudio(
  videoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  if (
    isYoutubeSignedIn() &&
    prefersAccountPlayback() &&
    (await appAllowsAccountPlayback())
  ) {
    try {
      const stream = await resolveTvAudio(videoId, progressive, signal);
      log("cyan", "playback", `resolved youtube tv audio for ${videoId}`);
      return stream;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      log("yellow", "playback", `youtube tv playback failed: ${String(error)}`);
    }
  }
  return fromInnertubeStream(
    await resolveDirectAudioStream(videoId, { signal }),
  );
}

async function resolveYoutubeStandIn(
  track: PlayableTrack,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  const videoId = await findYoutubeStandIn(track, signal);
  if (!videoId) throw new Error("No matching YouTube track found");
  log(
    "cyan",
    "playback",
    `resolved youtube stand-in ${videoId} for "${track.title}"`,
  );
  const stream = await resolveYoutubeAudio(videoId, progressive, signal);
  stream.standIn = true;
  return stream;
}

async function resolveSoundCloud(
  track: PlayableTrack,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  try {
    return fromSoundCloudStream(
      await resolveSoundCloudStream(track.id, { signal }),
    );
  } catch (soundCloudError) {
    if (isAbortError(soundCloudError, signal)) throw soundCloudError;
    log(
      "yellow",
      "playback",
      `soundcloud resolution failed, searching youtube: ${String(soundCloudError)}`,
    );
    try {
      return await resolveYoutubeStandIn(track, progressive, signal);
    } catch (standInError) {
      if (isAbortError(standInError, signal)) throw standInError;
      throw soundCloudError;
    }
  }
}

async function resolveYoutubeTrack(
  track: PlayableTrack,
  rowVideoId: string,
  progressive: boolean,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  const songId = track.audioVariant
    ? await findExactSongVersion(track, rowVideoId, signal)
    : null;
  if (songId)
    log(
      "cyan",
      "playback",
      `album row ${rowVideoId} is a ${track.audioVariant}, playing the song ${songId}`,
    );
  const videoId = songId ?? rowVideoId;
  const liner = await resolveLinerStream(videoId, signal);
  if (liner) {
    log("cyan", "playback", `resolved liner audio (r2) for "${track.title}"`);
    return fromLinerStream(liner, track);
  }
  return resolveYoutubeAudio(videoId, progressive, signal);
}

export async function resolvePlaybackStream(
  track: PlayableTrack,
  signal?: AbortSignal,
  options: ResolveStreamOptions = {},
): Promise<PlaybackStream> {
  const stream = await resolveStream(track, signal, options);
  rememberStreamOrigin(track.id, stream);
  return stream;
}

async function resolveStream(
  track: PlayableTrack,
  signal?: AbortSignal,
  options: ResolveStreamOptions = {},
): Promise<PlaybackStream> {
  const progressive = options.progressive ?? false;
  if (isLocalTrackId(track.id))
    return {
      url: localTrackAudioUrl(track.id),
      source: "local",
      expiresAtMs: null,
      mimeType: "",
      codec: "local",
      bitrate: 0,
    };
  const saved = savedTrackRecord(track.id);
  if (saved)
    return {
      url: savedAudioUrl(saved),
      expiresAtMs: null,
      mimeType: saved.mimeType,
      codec: "local",
      bitrate: 0,
    };
  if (isOfflineMode()) throw new Error(OFFLINE_UNAVAILABLE_MESSAGE);
<<<<<<< HEAD
  const resolve = (bounded: AbortSignal | undefined) => {
=======
  const resolve = async (bounded: AbortSignal | undefined) =>
    toAndroidBuffered(await resolveRaw(bounded), bounded);
  const resolveRaw = (bounded: AbortSignal | undefined) => {
>>>>>>> e9cee71 (youtube music + soundcloud)
    if (isSaavnId(track.id)) return resolveSaavnStream(track.id, bounded);
    if (toSoundCloudTrackId(track.id))
      return resolveSoundCloud(track, progressive, bounded);
    const videoId = toVideoId(track.id);
    if (videoId)
      return resolveYoutubeTrack(track, videoId, progressive, bounded);
    return resolveYoutubeStandIn(track, progressive, bounded);
  };
  return progressive ? withResolveTimeout(signal, resolve) : resolve(signal);
}

<<<<<<< HEAD
=======
// the WebView cannot stream cross-origin audio (no CORS), so on Android remote
// url streams are downloaded through the native layer into a blob first
async function toAndroidBuffered(
  stream: PlaybackStream,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  if (!isAndroidApp() || stream.blob || !stream.url) return stream;
  if (!/^https?:/i.test(stream.url) || /mpegurl/i.test(stream.mimeType))
    return stream;
  const blob = await downloadAudioBlob(
    stream.url,
    stream.mimeType,
    signal,
    stream.contentLength,
  );
  stream.release?.();
  return {
    source: stream.source,
    mimeType: stream.mimeType,
    codec: stream.codec,
    bitrate: stream.bitrate,
    ...(stream.standIn ? { standIn: true } : {}),
    blob,
    expiresAtMs: null,
  };
}

>>>>>>> e9cee71 (youtube music + soundcloud)
export const RESOLVE_TIMEOUT_MS = 25_000;
export const RESOLVE_TIMEOUT_MESSAGE =
  "Timed out looking for a playable stream";

export async function withResolveTimeout<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = new Error(RESOLVE_TIMEOUT_MESSAGE);
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timedOut);
      reject(timedOut);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
