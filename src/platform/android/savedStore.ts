// Offline "saved tracks" for the Android build. The desktop app writes files from the
// Electron main process; here the audio, cover and lyrics are kept in IndexedDB inside
// the app and played back through blob urls.
import type {
  SavedLibraryUsage,
  SavedLyricsState,
  SavedTrackInput,
  SavedTrackRecord,
} from "../../../electron/saved-tracks/types";

const DB_NAME = "liner-android-saved";
const RECORDS = "records";
const BLOBS = "blobs";
const LYRICS = "lyrics";

interface BlobRow {
  key: string;
  audio: Blob;
  cover?: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(RECORDS, { keyPath: "key" });
      db.createObjectStore(BLOBS, { keyPath: "key" });
      db.createObjectStore(LYRICS, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function savedKey(trackId: string): string {
  return `sv_${encodeURIComponent(trackId)}`;
}

// blob urls for audio and covers, filled on list/save so savedAudioUrl() can stay sync
const urls = new Map<string, string>();
const urlKey = (kind: "audio" | "cover", key: string) => `${kind}:${key}`;

export function savedObjectUrl(
  kind: "audio" | "cover",
  key: string,
): string | undefined {
  return urls.get(urlKey(kind, key));
}

function publish(row: BlobRow): void {
  for (const [kind, blob] of [
    ["audio", row.audio],
    ["cover", row.cover],
  ] as const) {
    const id = urlKey(kind, row.key);
    const old = urls.get(id);
    if (old) URL.revokeObjectURL(old);
    if (blob) urls.set(id, URL.createObjectURL(blob));
    else urls.delete(id);
  }
}

export async function savedList(): Promise<SavedTrackRecord[]> {
  const records = await run<SavedTrackRecord[]>(RECORDS, "readonly", (s) => s.getAll());
  const rows = await run<BlobRow[]>(BLOBS, "readonly", (s) => s.getAll());
  const live = new Set<string>();
  for (const row of rows) {
    live.add(row.key);
    if (!urls.has(urlKey("audio", row.key))) publish(row);
  }
  return records
    .filter((r) => live.has(r.key))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function savedSave(
  input: SavedTrackInput,
): Promise<SavedTrackRecord | null> {
  const key = savedKey(input.meta.trackId);
  const audio = new Blob([input.audio as BlobPart], {
    type: input.mimeType || "audio/mp4",
  });
  const cover = input.cover
    ? new Blob([input.cover.data as BlobPart], { type: input.cover.mimeType })
    : undefined;
  const record: SavedTrackRecord = {
    ...input.meta,
    key,
    audioFile: "audio",
    mimeType: audio.type,
    ...(cover ? { coverFile: "cover" } : {}),
    byteSize: audio.size,
    savedAt: Date.now(),
    ...(input.lyricsState ? { lyrics: input.lyricsState } : {}),
  };
  const row: BlobRow = { key, audio, ...(cover ? { cover } : {}) };
  await run(BLOBS, "readwrite", (s) => s.put(row));
  await run(RECORDS, "readwrite", (s) => s.put(record));
  if (input.lyricsState === "found" && input.lyrics !== undefined)
    await run(LYRICS, "readwrite", (s) => s.put({ key, lyrics: input.lyrics }));
  publish(row);
  return record;
}

export async function savedRemove(trackIds: string[]): Promise<number> {
  let removed = 0;
  for (const trackId of trackIds) {
    const key = savedKey(trackId);
    const existing = await run(RECORDS, "readonly", (s) => s.get(key));
    if (!existing) continue;
    await run(RECORDS, "readwrite", (s) => s.delete(key));
    await run(BLOBS, "readwrite", (s) => s.delete(key));
    await run(LYRICS, "readwrite", (s) => s.delete(key));
    for (const kind of ["audio", "cover"] as const) {
      const id = urlKey(kind, key);
      const url = urls.get(id);
      if (url) URL.revokeObjectURL(url);
      urls.delete(id);
    }
    removed++;
  }
  return removed;
}

export async function savedRemoveAll(): Promise<number> {
  const records = await run<SavedTrackRecord[]>(RECORDS, "readonly", (s) => s.getAll());
  return savedRemove(records.map((r) => r.trackId));
}

export async function savedUsage(): Promise<SavedLibraryUsage> {
  const records = await run<SavedTrackRecord[]>(RECORDS, "readonly", (s) => s.getAll());
  let freeBytes: number | null = null;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota !== undefined && usage !== undefined) freeBytes = Math.max(0, quota - usage);
  } catch {
    // estimate not supported
  }
  return {
    count: records.length,
    bytes: records.reduce((sum, r) => sum + r.byteSize, 0),
    freeBytes,
  };
}

export async function savedGetLyrics(trackId: string): Promise<unknown | null> {
  const row = await run<{ lyrics?: unknown } | undefined>(LYRICS, "readonly", (s) =>
    s.get(savedKey(trackId)),
  );
  return row?.lyrics ?? null;
}

export async function savedSetLyrics(
  trackId: string,
  state: SavedLyricsState,
  lyrics?: unknown,
): Promise<boolean> {
  const key = savedKey(trackId);
  const record = await run<SavedTrackRecord | undefined>(RECORDS, "readonly", (s) => s.get(key));
  if (!record) return false;
  await run(RECORDS, "readwrite", (s) => s.put({ ...record, lyrics: state }));
  if (state === "found" && lyrics !== undefined)
    await run(LYRICS, "readwrite", (s) => s.put({ key, lyrics }));
  return true;
}
