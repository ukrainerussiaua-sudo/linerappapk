// A tiny in-app replacement for the Liner server: the user library (likes, saved
// albums/artists/playlists, own playlists, history) lives in localStorage.
import type {
  ApiTrack,
  ApiUserPlaylist,
  ApiUserPlaylistItem,
  AuthUser,
  PlaybackHistoryItem,
  RecordPlaybackEventRequest,
} from "@/shared/contracts";
import {
  explorePopularAlbums,
  explorePopularTracks,
} from "../saavn/saavnExplore";

type CollectionType = "albums" | "artists" | "playlists";

interface StoredPlaylist {
  meta: ApiUserPlaylist;
  items: ApiUserPlaylistItem[];
}

interface Store {
  user: AuthUser;
  likes: { track: ApiTrack; likedAt: string }[];
  collections: Record<CollectionType, { value: Record<string, unknown>; savedAt: string }[]>;
  playlists: StoredPlaylist[];
  history: PlaybackHistoryItem[];
}

const KEY = "liner.guest.library.v1";

export const GUEST_USER: AuthUser = {
  id: "guest",
  username: "guest",
  displayName: "Guest",
  isPublic: false,
  showActivity: false,
  showHistory: false,
  showLikedTracks: false,
  participateLeaderboards: false,
};

export class GuestHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "GUEST_LOCAL",
  ) {
    super(message);
  }
}

let memory: Store | null = null;

function empty(): Store {
  return {
    user: { ...GUEST_USER },
    likes: [],
    collections: { albums: [], artists: [], playlists: [] },
    playlists: [],
    history: [],
  };
}

function load(): Store {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      memory = { ...empty(), ...parsed, collections: { ...empty().collections, ...parsed.collections } };
      return memory;
    }
  } catch {
    // fall through to an empty library
  }
  memory = empty();
  return memory;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // storage full or unavailable: the library stays in memory for this session
  }
}

export function resetGuestStoreForTests(): void {
  memory = null;
}

const now = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function summarize(p: StoredPlaylist): ApiUserPlaylist {
  const covers = p.items
    .map((i) => i.track.cover?.url)
    .filter((u): u is string => !!u)
    .slice(0, 4);
  return { ...p.meta, trackCount: p.items.length, coverUrls: covers };
}

function renumber(p: StoredPlaylist): void {
  p.items.forEach((item, index) => (item.position = index));
  p.meta.revision += 1;
  p.meta.updatedAt = now();
}

function findPlaylist(id: string): StoredPlaylist {
  const found = load().playlists.find((p) => p.meta.id === id);
  if (!found) throw new GuestHttpError(404, "Playlist not found", "PLAYLIST_NOT_FOUND");
  return found;
}

function page<T>(all: T[], cursor: string | null, limit: number) {
  const start = cursor ? Number(cursor) || 0 : 0;
  const items = all.slice(start, start + limit);
  const next = start + limit < all.length ? String(start + limit) : null;
  return { items, nextCursor: next };
}

const singular = { albums: "album", artists: "artist", playlists: "playlist" } as const;

export interface GuestRequest {
  method: string;
  path: string;
  body?: unknown;
}

export function handleGuestRequest({ method, path: rawPath, body }: GuestRequest): unknown {
  const url = new URL(rawPath, "http://guest.local");
  const path = url.pathname;
  const q = url.searchParams;
  const data = store();
  const b = (body ?? {}) as Record<string, any>;
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
  // seg[0] === "v1"
  const [, a, c, d, e, f] = seg;

  if (a === "me" && !c) return data.user;
  if (a === "users" && c === "me" && method === "PATCH") {
    data.user = { ...data.user, ...b };
    save();
    return data.user;
  }

  if (a === "me" && c === "library") {
    if (d === "tracks") {
      if (!e) {
        const sorted = [...data.likes].sort((x, y) => y.likedAt.localeCompare(x.likedAt));
        return page(sorted, q.get("cursor"), Number(q.get("limit")) || 100);
      }
      if (method === "PUT") {
        const track = (b.track ?? b.trackSnapshot) as ApiTrack | undefined;
        if (track && !data.likes.some((l) => l.track.id === e)) {
          data.likes.push({ track: { ...track, id: e }, likedAt: now() });
          save();
        }
        return undefined;
      }
      if (method === "DELETE") {
        data.likes = data.likes.filter((l) => l.track.id !== e);
        save();
        return undefined;
      }
    }
    if (d === "albums" || d === "artists" || d === "playlists") {
      const list = data.collections[d];
      if (!e) {
        const key = singular[d];
        return {
          items: [...list]
            .sort((x, y) => y.savedAt.localeCompare(x.savedAt))
            .map((entry) => ({ [key]: entry.value, savedAt: entry.savedAt })),
        };
      }
      if (method === "PUT") {
        const snapshot = (b.snapshot ?? {}) as Record<string, unknown>;
        const value = { ...snapshot, id: e };
        const index = list.findIndex((x) => x.value.id === e);
        if (index >= 0) list[index] = { value, savedAt: list[index]!.savedAt };
        else list.push({ value, savedAt: now() });
        save();
        return undefined;
      }
      if (method === "DELETE") {
        data.collections[d] = list.filter((x) => x.value.id !== e);
        save();
        return undefined;
      }
    }
  }

  if (a === "me" && c === "playlists") {
    if (!d) {
      if (method === "POST") {
        const title = String(b.title ?? "").trim() || "New playlist";
        const stamp = now();
        const created: StoredPlaylist = {
          meta: {
            id: uid("pl"),
            title,
            ...(b.description ? { description: String(b.description) } : {}),
            isPublic: false,
            createdAt: stamp,
            updatedAt: stamp,
            revision: 1,
          },
          items: [],
        };
        data.playlists.push(created);
        save();
        return summarize(created);
      }
      return { items: data.playlists.map(summarize) };
    }
    const playlist = findPlaylist(d);
    if (!e) {
      if (method === "PATCH") {
        if (typeof b.title === "string" && b.title.trim()) playlist.meta.title = b.title.trim();
        if ("description" in b) {
          if (b.description) playlist.meta.description = String(b.description);
          else delete playlist.meta.description;
        }
        playlist.meta.revision += 1;
        playlist.meta.updatedAt = now();
        save();
        return summarize(playlist);
      }
      if (method === "DELETE") {
        data.playlists = data.playlists.filter((p) => p !== playlist);
        save();
        return undefined;
      }
      const durationMs = playlist.items.reduce((s, i) => s + (i.track.durationMs || 0), 0);
      return {
        playlist: summarize(playlist),
        items: playlist.items,
        trackCount: playlist.items.length,
        durationMs,
        partial: false,
      };
    }
    if (e === "tracks") {
      const incoming: ApiTrack[] = f
        ? [(b.track ?? b.trackSnapshot ?? { id: f }) as ApiTrack]
        : ((b.tracks ?? []) as ApiTrack[]);
      const added: ApiUserPlaylistItem[] = incoming
        .filter((t) => t?.id)
        .map((track) => ({
          id: uid("it"),
          track: f ? { ...track, id: f } : track,
          position: 0,
          addedAt: now(),
        }));
      playlist.items.push(...added);
      renumber(playlist);
      save();
      if (f) return added[0];
      return { items: added, added: added.length, rejected: incoming.length - added.length };
    }
    if (e === "items" && f) {
      const move = seg[6] === "move";
      if (move && method === "POST") {
        const index = playlist.items.findIndex((i) => i.id === f);
        if (index >= 0) {
          const [item] = playlist.items.splice(index, 1);
          const before = b.beforeItemId
            ? playlist.items.findIndex((i) => i.id === b.beforeItemId)
            : -1;
          playlist.items.splice(before >= 0 ? before : playlist.items.length, 0, item!);
          renumber(playlist);
          save();
        }
        return { playlist: summarize(playlist), items: playlist.items };
      }
      if (method === "DELETE") {
        playlist.items = playlist.items.filter((i) => i.id !== f);
        renumber(playlist);
        save();
        return undefined;
      }
    }
  }

  if (a === "me" && c === "playback" && d === "events" && method === "POST") {
    const ev = b as RecordPlaybackEventRequest;
    if (ev.trackSnapshot) {
      data.history.unshift({
        id: uid("h"),
        playbackSessionId: ev.playbackSessionId,
        listeningSessionId: ev.listeningSessionId,
        track: ev.trackSnapshot,
        playedDurationMs: ev.playedDurationMs,
        completionRate: ev.completionRate,
        completed: ev.completed ?? false,
        skipped: ev.skipped ?? false,
        loopCount: ev.loopCount ?? 0,
        hasSeekBackward: ev.hasSeekBackward ?? false,
        ...(ev.context ? { context: ev.context } : {}),
        listenedAt: now(),
      });
      data.history = data.history.slice(0, 300);
      save();
    }
    return undefined;
  }
  if (a === "me" && c === "history") {
    return page(data.history, q.get("cursor"), Number(q.get("limit")) || 30);
  }
  if (a === "me" && c === "recommendations") {
    return { items: [], generatedAt: now() };
  }
  if (a === "explore") {
    const window = q.get("window") ?? "7d";
    const limit = Number(q.get("limit")) || 20;
    if (c === "popular" && d === "albums") return explorePopularAlbums(window, limit);
    if (c === "popular") return explorePopularTracks(window, limit);
    if (c === "most-saved") return { type: q.get("type") ?? "all", items: [] };
    return { window, generatedAt: now(), items: [] };
  }
  if (a === "leaderboards") return { items: [] };
  if (a === "presence" || a === "client" || a === "health" || a === "ingest")
    return undefined;

  throw new GuestHttpError(404, "Not available without the Liner server", "GUEST_UNAVAILABLE");
}

function store(): Store {
  return load();
}
