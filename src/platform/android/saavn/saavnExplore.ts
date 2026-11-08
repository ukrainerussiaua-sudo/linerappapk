// Home / explore content for the Android build, taken from JioSaavn's launch data.
import type {
  PopularAlbumsResponse,
  PopularTracksResponse,
} from "@/shared/contracts";
import {
  decodeEntities,
  mapArtists,
  mapSongs,
  saavnCall,
  toCover,
  toSaavnId,
} from "./saavnApi";

let launch: Promise<any> | null = null;
let launchAt = 0;

function launchData(): Promise<any> {
  if (!launch || Date.now() - launchAt > 10 * 60_000) {
    launchAt = Date.now();
    launch = saavnCall("webapi.getLaunchData").catch((e) => {
      launch = null;
      throw e;
    });
  }
  return launch;
}

export async function explorePopularTracks(
  window: string,
  limit: number,
): Promise<PopularTracksResponse> {
  const generatedAt = new Date().toISOString();
  try {
    const data = await launchData();
    const charts: any[] = Array.isArray(data?.charts) ? data.charts : [];
    let tracks: ReturnType<typeof mapSongs> = [];
    for (const chart of charts.slice(0, 3)) {
      const list = await saavnCall("playlist.getDetails", {
        listid: chart.id,
        n: limit,
        p: 1,
      }).catch(() => null);
      tracks = mapSongs(list?.list);
      if (tracks.length) break;
    }
    return {
      window: window as PopularTracksResponse["window"],
      generatedAt,
      items: tracks.slice(0, limit).map((track, index) => ({
        rank: index + 1,
        track,
        playCount: 0,
        uniqueListeners: 0,
        score: limit - index,
      })),
    };
  } catch {
    return { window: window as PopularTracksResponse["window"], generatedAt, items: [] };
  }
}

export async function explorePopularAlbums(
  window: string,
  limit: number,
): Promise<PopularAlbumsResponse> {
  try {
    const data = await launchData();
    const albums: any[] = Array.isArray(data?.new_albums) ? data.new_albums : [];
    return {
      window: window as PopularAlbumsResponse["window"],
      items: albums
        .filter((a) => a?.id)
        .slice(0, limit)
        .map((a, index) => {
          const artists = mapArtists(a);
          const year = Number(a.year);
          return {
            id: toSaavnId(a.id),
            title: decodeEntities(a.title),
            artist: artists.map((x) => x.name).join(", "),
            artists,
            coverUrl: toCover(a.image)?.url ?? null,
            ...(Number.isFinite(year) && year > 0 ? { year } : {}),
            playCount: 0,
            uniqueListeners: 0,
            trackCount: Number(a.more_info?.song_count ?? a.list_count ?? 0) || 0,
            score: limit - index,
          };
        }),
    };
  } catch {
    return { window: window as PopularAlbumsResponse["window"], items: [] };
  }
}
