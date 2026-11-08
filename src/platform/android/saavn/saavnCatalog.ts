import type {
  AlbumDetails,
  ApiTrack,
  ArtistAlbum,
  ArtistDetails,
  ArtistRelease,
  CatalogPlaylistDetails,
  RadioResponse,
  SearchResponse,
  SearchType,
  TrackDetails,
} from "@/shared/contracts";
import {
  decodeEntities,
  mapAlbumItem,
  mapArtistItem,
  mapArtists,
  mapPlaylistItem,
  mapSong,
  mapSongs,
  saavnCall,
  stripSaavnId,
  toCover,
  toSaavnId,
} from "./saavnApi";

const sum = (tracks: ApiTrack[]) =>
  tracks.reduce((total, t) => total + (t.durationMs || 0), 0);

async function searchTracks(q: string, n: number) {
  const res = await saavnCall("search.getResults", { q, p: 1, n });
  return mapSongs(res?.results);
}

async function searchAlbums(q: string, n: number) {
  const res = await saavnCall("search.getAlbumResults", { q, p: 1, n });
  return ((res?.results ?? []) as any[]).filter((a) => a?.id).map(mapAlbumItem);
}

async function searchArtists(q: string, n: number) {
  const res = await saavnCall("search.getArtistResults", { q, p: 1, n });
  return ((res?.results ?? []) as any[]).filter((a) => a?.id).map(mapArtistItem);
}

async function searchPlaylists(q: string, n: number) {
  const res = await saavnCall("search.getPlaylistResults", { q, p: 1, n });
  return ((res?.results ?? []) as any[])
    .filter((p) => p?.id)
    .map(mapPlaylistItem);
}

function releaseYear(raw: any): number | undefined {
  const year = Number(raw?.year);
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function toArtistAlbum(raw: any): ArtistAlbum {
  const year = releaseYear(raw);
  const count = Number(raw?.more_info?.song_count ?? raw?.list_count);
  return {
    id: toSaavnId(raw.id),
    title: decodeEntities(raw.title),
    ...(year ? { year } : {}),
    ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
    ...(Number.isFinite(count) && count > 0 ? { trackCount: count } : {}),
  };
}

function listOf(value: any, key: string): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function parseBio(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const text = parsed
        .map((p) => decodeEntities(p?.text))
        .filter(Boolean)
        .join("\n\n");
      return text || undefined;
    }
  } catch {
    // plain text bio
  }
  return decodeEntities(raw.replace(/<[^>]+>/g, ""));
}

export const saavnCatalog = {
  async search(query: string, type: SearchType): Promise<SearchResponse> {
    const q = query.trim();
    if (!q) return { items: [] };
    if (type === "track")
      return { items: (await searchTracks(q, 30)).map((t) => ({ ...t, type: "track" as const })) };
    if (type === "album") return { items: await searchAlbums(q, 24) };
    if (type === "artist") return { items: await searchArtists(q, 20) };
    if (type === "playlist") return { items: await searchPlaylists(q, 20) };
    const [tracks, albums, artists, playlists] = await Promise.all([
      searchTracks(q, 20).catch(() => []),
      searchAlbums(q, 8).catch(() => []),
      searchArtists(q, 5).catch(() => []),
      searchPlaylists(q, 5).catch(() => []),
    ]);
    return {
      items: [
        ...artists,
        ...tracks.map((t) => ({ ...t, type: "track" as const })),
        ...albums,
        ...playlists,
      ],
    };
  },

  async getTrack(id: string): Promise<TrackDetails> {
    const res = await saavnCall("song.getDetails", { pids: stripSaavnId(id) });
    const raw = res?.songs?.[0] ?? res?.[stripSaavnId(id)];
    if (!raw) throw new Error("Track not found");
    const track = mapSong(raw);
    const related = await saavnCatalog
      .getRadio(id, 12)
      .then((r) => r.items)
      .catch(() => []);
    return {
      ...track,
      ...(raw.more_info?.release_date
        ? { releaseDate: String(raw.more_info.release_date) }
        : {}),
      relatedTracks: related,
    };
  },

  async getAlbum(id: string): Promise<AlbumDetails> {
    const raw = await saavnCall("content.getAlbumDetails", {
      albumid: stripSaavnId(id),
    });
    if (!raw?.id) throw new Error("Album not found");
    const tracks = mapSongs(raw.list);
    return {
      type: "album",
      id: toSaavnId(raw.id),
      title: decodeEntities(raw.title),
      artists: mapArtists(raw),
      ...(releaseYear(raw) ? { year: releaseYear(raw) } : {}),
      ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
      trackCount: tracks.length,
      durationMs: sum(tracks),
      tracks,
    };
  },

  async getArtist(id: string): Promise<ArtistDetails> {
    const raw = await saavnCall("artist.getArtistPageDetails", {
      artistId: stripSaavnId(id),
      n_song: 25,
      n_album: 25,
      page: 0,
      category: "",
      sort_order: "",
    });
    if (!raw?.artistId && !raw?.name) throw new Error("Artist not found");
    const tracks = mapSongs(listOf(raw.topSongs, "songs"));
    const albums = listOf(raw.topAlbums, "albums")
      .filter((a) => a?.id)
      .map(toArtistAlbum);
    const singles: ArtistRelease[] = listOf(raw.singles, "albums")
      .filter((a) => a?.id)
      .map((a) => ({ ...toArtistAlbum(a), releaseType: "single" as const }));
    const followers = Number(raw.follower_count ?? raw.fan_count);
    return {
      type: "artist",
      id: toSaavnId(raw.artistId ?? stripSaavnId(id)),
      name: decodeEntities(raw.name),
      ...(parseBio(raw.bio) ? { bio: parseBio(raw.bio) } : {}),
      ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
      ...(Number.isFinite(followers) && followers > 0 ? { followers } : {}),
      verified: raw.isVerified === true || raw.isVerified === "true",
      tracks,
      albums,
      singles,
    };
  },

  async getArtistImage(id: string): Promise<string | undefined> {
    const artist = await saavnCatalog.getArtist(id).catch(() => null);
    return artist?.cover?.url;
  },

  async getPlaylist(id: string): Promise<CatalogPlaylistDetails> {
    const raw = await saavnCall("playlist.getDetails", {
      listid: stripSaavnId(id),
      n: 200,
      p: 1,
    });
    if (!raw?.id) throw new Error("Playlist not found");
    const tracks = mapSongs(raw.list);
    const author = decodeEntities(raw.more_info?.firstname || raw.subtitle);
    const description = decodeEntities(raw.header_desc);
    return {
      type: "playlist",
      id: toSaavnId(raw.id),
      title: decodeEntities(raw.title),
      ...(author ? { author } : {}),
      ...(description ? { description } : {}),
      ...(toCover(raw.image) ? { cover: toCover(raw.image) } : {}),
      trackCount: tracks.length,
      durationMs: sum(tracks),
      tracks,
    };
  },

  async getRadio(id: string, k?: number): Promise<RadioResponse> {
    const limit = Math.max(1, Math.min(k ?? 20, 50));
    const res = await saavnCall("reco.getreco", { pid: stripSaavnId(id) });
    const list = Array.isArray(res) ? res : (res?.songs ?? []);
    const items = mapSongs(list)
      .slice(0, limit)
      .map(({ id: trackId, title, artists, album, durationMs, cover, explicit }) => ({
        id: trackId,
        title,
        artists,
        ...(album ? { album } : {}),
        durationMs,
        ...(cover ? { cover } : {}),
        ...(explicit ? { explicit } : {}),
      }));
    return { items };
  },

  async resolveSnapshot(id: string): Promise<ApiTrack | undefined> {
    const res = await saavnCall("song.getDetails", { pids: stripSaavnId(id) }).catch(
      () => null,
    );
    const raw = res?.songs?.[0];
    return raw ? mapSong(raw) : undefined;
  },
};
