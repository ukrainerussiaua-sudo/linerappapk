// JioSaavn web API: the music source of the Android build (the same one Muzo uses for
// search and audio). Everything here is client side; there is no Liner server involved.
import CryptoJS from "crypto-js";
import type {
  ApiTrack,
  Cover,
  SearchAlbumItem,
  SearchArtistItem,
  SearchPlaylistItem,
} from "@/shared/contracts";
import { nativeGetJson } from "../native";

const BASE = "https://www.jiosaavn.com/api.php";
const COMMON = {
  _format: "json",
  _marker: "0",
  api_version: "4",
  ctx: "web6dot0",
};
const DES_KEY = "38346591";

export const SAAVN_PREFIX = "sv:";

export function isSaavnId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(SAAVN_PREFIX);
}

export function stripSaavnId(id: string): string {
  return id.startsWith(SAAVN_PREFIX) ? id.slice(SAAVN_PREFIX.length) : id;
}

export function toSaavnId(raw: string | number): string {
  return `${SAAVN_PREFIX}${raw}`;
}

export async function saavnCall<T = any>(
  call: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams({
    __call: call,
    ...COMMON,
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  });
  return nativeGetJson<T>(`${BASE}?${query}`, { Accept: "application/json" }, signal);
}

export function decryptMediaUrl(encrypted: string): string {
  const cipherParams = { ciphertext: CryptoJS.enc.Base64.parse(encrypted) } as any;
  const out = CryptoJS.DES.decrypt(cipherParams, CryptoJS.enc.Utf8.parse(DES_KEY), {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return out.toString(CryptoJS.enc.Utf8);
}

export function decodeEntities(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (!text.includes("&")) return text;
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function toCover(image: unknown, size = 500): Cover | undefined {
  if (typeof image !== "string" || !image) return undefined;
  const url = image
    .replace(/^http:/, "https:")
    .replace(/\d+x\d+(?=\.\w+$)/, `${size}x${size}`);
  return { url, width: size, height: size };
}

export interface SaavnMedia {
  encrypted: string;
  has320: boolean;
}

const mediaByTrack = new Map<string, SaavnMedia>();

export function rememberMedia(id: string, media: SaavnMedia): void {
  mediaByTrack.set(id, media);
  if (mediaByTrack.size > 400) {
    const oldest = mediaByTrack.keys().next().value as string;
    mediaByTrack.delete(oldest);
  }
}

export function recallMedia(id: string): SaavnMedia | undefined {
  return mediaByTrack.get(id);
}

type Person = { id?: string; name?: string };

function people(list: unknown): { id: string; name: string }[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const item of list as Person[]) {
    const name = decodeEntities(item?.name);
    if (!name || !item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: toSaavnId(item.id), name });
  }
  return out;
}

export function mapArtists(raw: any): { id: string; name: string }[] {
  const map = raw?.more_info?.artistMap;
  const primary = people(map?.primary_artists);
  if (primary.length > 0) return primary;
  const any = people(map?.artists);
  if (any.length > 0) return any;
  const fallback = decodeEntities(
    raw?.more_info?.music || raw?.subtitle?.split(" - ")[0] || "",
  );
  return [{ id: toSaavnId("unknown"), name: fallback || "Unknown artist" }];
}

export function mapSong(raw: any): ApiTrack {
  const id = toSaavnId(raw.id);
  const info = raw.more_info ?? {};
  if (info.encrypted_media_url) {
    rememberMedia(id, {
      encrypted: info.encrypted_media_url,
      has320: info["320kbps"] === "true" || info["320kbps"] === true,
    });
  }
  const seconds = Number(info.duration ?? raw.duration ?? 0);
  const albumId = info.album_id;
  return {
    type: "track",
    id,
    title: decodeEntities(raw.title),
    artists: mapArtists(raw),
    ...(albumId && info.album
      ? {
          album: {
            id: toSaavnId(albumId),
            title: decodeEntities(info.album),
          },
        }
      : {}),
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
    explicit: raw.explicit_content === "1" || raw.explicit_content === 1,
  };
}

export function mapSongs(list: unknown): ApiTrack[] {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && s.id).map(mapSong);
}

export function mapAlbumItem(raw: any): SearchAlbumItem {
  const year = Number(raw.year);
  return {
    type: "album",
    id: toSaavnId(raw.id),
    title: decodeEntities(raw.title),
    artists: mapArtists(raw),
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
  };
}

export function mapArtistItem(raw: any): SearchArtistItem {
  return {
    type: "artist",
    id: toSaavnId(raw.id ?? raw.artistId),
    name: decodeEntities(raw.name ?? raw.title),
    ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
  };
}

export function mapPlaylistItem(raw: any): SearchPlaylistItem {
  const author = decodeEntities(raw.subtitle || raw.more_info?.firstname);
  return {
    type: "playlist",
    id: toSaavnId(raw.id),
    title: decodeEntities(raw.title),
    ...(author ? { author } : {}),
    ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
  };
}
