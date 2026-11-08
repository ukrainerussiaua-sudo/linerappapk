import type { PlaybackStream } from "@/features/player/engine/playbackStream";
import { nativeGetBlob } from "../native";
import {
  decryptMediaUrl,
  mapSong,
  recallMedia,
  rememberMedia,
  saavnCall,
  stripSaavnId,
} from "./saavnApi";

async function mediaFor(id: string, signal?: AbortSignal) {
  const known = recallMedia(id);
  if (known) return known;
  const res = await saavnCall("song.getDetails", { pids: stripSaavnId(id) }, signal);
  const raw = res?.songs?.[0];
  if (!raw) throw new Error("Track not found on JioSaavn");
  mapSong(raw); // remembers the media url
  const media = recallMedia(id);
  if (!media) throw new Error("JioSaavn did not return a playable stream");
  return media;
}

export function saavnQualityUrls(url: string, has320: boolean): string[] {
  const https = url.replace(/^http:/, "https:");
  const at = (bitrate: number) => https.replace(/_\d+(\.\w+)$/, `_${bitrate}$1`);
  return has320 ? [at(320), at(160), at(96)] : [at(160), at(96)];
}

export async function resolveSaavnStream(
  id: string,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  const media = await mediaFor(id, signal);
  const base = decryptMediaUrl(media.encrypted);
  if (!/^https?:\/\//.test(base)) throw new Error("Could not decode the stream url");
  let lastError: unknown;
  for (const url of saavnQualityUrls(base, media.has320)) {
    try {
      const blob = await nativeGetBlob(url, {}, signal);
      if (blob.size < 10_000) throw new Error("stream too small");
      const bitrate = Number(/_(\d+)\.\w+$/.exec(url)?.[1] ?? 96) * 1000;
      return {
        blob: new Blob([blob], { type: "audio/mp4" }),
        source: "saavn",
        mimeType: "audio/mp4",
        codec: "aac",
        bitrate,
        contentLength: blob.size,
        expiresAtMs: null,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No playable stream");
}

export { rememberMedia };
