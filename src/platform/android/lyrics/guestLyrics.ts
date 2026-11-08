// Lyrics for the Android build, without the Liner server:
//  - lrclib.net      -> line synced (lrc) or plain text
//  - lyrics.geeked.wtf -> word/syllable synced, converted to richsync so the existing
//    word-by-word animation keeps working unchanged
import type {
  LyricsCandidate,
  LyricsSearchResult,
  LyricsStreamEvent,
} from "@/shared/contracts";
import { nativeGetJson } from "../native";

export interface LyricsHint {
  title?: string;
  artist?: string;
  durationMs?: number;
}

const quality = (total: number, reasons: string[]) => ({
  total,
  match: 90,
  content: total,
  sync: total,
  source: 70,
  reasons,
});

export function lrcFromLines(lines: { timeMs: number; text: string }[]): string {
  return lines
    .map(({ timeMs, text }) => {
      const m = Math.floor(timeMs / 60000);
      const s = ((timeMs % 60000) / 1000).toFixed(2).padStart(5, "0");
      return `[${String(m).padStart(2, "0")}:${s}]${text}`;
    })
    .join("\n");
}

interface GeekedSyllable {
  time?: number;
  duration?: number;
  text?: string;
}
interface GeekedLine {
  time?: number;
  duration?: number;
  endtime?: number;
  text?: string;
  syllabus?: GeekedSyllable[];
}

// richsync: [{ ts, te, x, l:[{ c, o }] }], times in seconds; o is absolute here, which
// the parser accepts when it is not smaller than the line start
export function geekedToRichsync(lines: GeekedLine[]): string | null {
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const syllables = (line.syllabus ?? []).filter(
      (s) => typeof s.text === "string" && typeof s.time === "number",
    );
    if (!syllables.length) continue;
    const start = line.time ?? syllables[0]!.time!;
    const last = syllables[syllables.length - 1]!;
    const nextStart = lines[i + 1]?.time;
    const end =
      line.endtime ??
      (line.duration ? start + line.duration : undefined) ??
      (last.time! + (last.duration ?? 0) || nextStart || start + 3000);
    out.push({
      ts: start / 1000,
      te: Math.max(end, start + 1) / 1000,
      x: syllables.map((s) => s.text).join(""),
      l: syllables.map((s) => ({ c: s.text, o: Math.max(s.time!, start) / 1000 })),
    });
  }
  return out.length ? JSON.stringify(out) : null;
}

function geekedToLrc(lines: GeekedLine[]): string | null {
  const mapped = lines
    .filter((l) => typeof l.time === "number" && l.text?.trim())
    .map((l) => ({ timeMs: l.time!, text: l.text!.trim() }));
  return mapped.length ? lrcFromLines(mapped) : null;
}

async function fromGeeked(hint: LyricsHint, signal?: AbortSignal) {
  if (!hint.title) return null;
  const params = new URLSearchParams({
    title: hint.title,
    artist: hint.artist ?? "",
    ...(hint.durationMs ? { duration: String(Math.round(hint.durationMs / 1000)) } : {}),
  });
  const res: any = await nativeGetJson(
    `https://lyrics.geeked.wtf/v2/lyrics/get?${params}`,
    {},
    signal,
  );
  const lines: GeekedLine[] = res?.lyrics?.lines ?? res?.lines ?? res?.lyrics ?? [];
  if (!Array.isArray(lines) || !lines.length) return null;
  const rich = geekedToRichsync(lines);
  if (rich) {
    return {
      provider: "geeked",
      contentKind: "syllable_synced",
      syncLevel: "syllable_level",
      lyrics: { format: "richsync", content: rich },
      quality: quality(92, ["word synced"]),
    } satisfies LyricsCandidate;
  }
  const lrc = geekedToLrc(lines);
  return lrc
    ? ({
        provider: "geeked",
        contentKind: "line_synced",
        syncLevel: "line_level",
        lyrics: { format: "lrc", content: lrc },
        quality: quality(72, ["line synced"]),
      } satisfies LyricsCandidate)
    : null;
}

async function fromLrclib(hint: LyricsHint, signal?: AbortSignal) {
  if (!hint.title) return null;
  const params = new URLSearchParams({
    track_name: hint.title,
    artist_name: hint.artist ?? "",
    ...(hint.durationMs ? { duration: String(Math.round(hint.durationMs / 1000)) } : {}),
  });
  let res: any = await nativeGetJson(
    `https://lrclib.net/api/get?${params}`,
    {},
    signal,
  ).catch(() => null);
  if (!res) {
    const list = await nativeGetJson<any[]>(
      `https://lrclib.net/api/search?${new URLSearchParams({
        track_name: hint.title,
        artist_name: hint.artist ?? "",
      })}`,
      {},
      signal,
    ).catch(() => []);
    res = list.find((r) => r?.syncedLyrics) ?? list[0] ?? null;
  }
  if (!res || res.instrumental) return null;
  if (typeof res.syncedLyrics === "string" && res.syncedLyrics.trim()) {
    return {
      provider: "lrclib",
      contentKind: "line_synced",
      syncLevel: "line_level",
      lyrics: { format: "lrc", content: res.syncedLyrics },
      quality: quality(70, ["line synced"]),
    } satisfies LyricsCandidate;
  }
  if (typeof res.plainLyrics === "string" && res.plainLyrics.trim()) {
    return {
      provider: "lrclib",
      contentKind: "plain",
      syncLevel: "plain",
      lyrics: { format: "plain", content: res.plainLyrics },
      quality: quality(30, ["plain text"]),
    } satisfies LyricsCandidate;
  }
  return null;
}

const SOURCES = [
  ["geeked", fromGeeked],
  ["lrclib", fromLrclib],
] as const;

export async function* guestLyricsEvents(
  hint: LyricsHint,
  signal?: AbortSignal,
): AsyncGenerator<LyricsStreamEvent> {
  const started = Date.now();
  const pending = SOURCES.map(([provider, load]) =>
    load(hint, signal)
      .then((candidate) => ({ provider, candidate, error: null as string | null }))
      .catch((e) => ({ provider, candidate: null, error: String(e?.message ?? e) })),
  );
  let best: LyricsCandidate | null = null;
  const racing = new Map(pending.map((p, i) => [i, p.then((v) => ({ i, v }))]));
  while (racing.size) {
    const { i, v } = await Promise.race(racing.values());
    racing.delete(i);
    const durationMs = Date.now() - started;
    if (v.candidate) {
      if (!best || v.candidate.quality.total > best.quality.total)
        best = v.candidate;
      yield {
        type: "provider",
        provider: v.provider,
        status: "found",
        syncLevel: v.candidate.syncLevel,
        candidate: v.candidate,
        durationMs,
      };
    } else if (v.error) {
      yield { type: "provider", provider: v.provider, status: "error", message: v.error, durationMs };
    } else {
      yield { type: "provider", provider: v.provider, status: "not_found", durationMs };
    }
  }
  yield {
    type: "done",
    cached: false,
    ...(best
      ? {
          best: {
            provider: best.provider,
            quality: best.quality.total,
            syncLevel: best.syncLevel,
          },
        }
      : { status: "not_found" as const }),
  };
}

export async function guestSearchLyrics(
  hint: LyricsHint,
  signal?: AbortSignal,
): Promise<LyricsSearchResult | null> {
  let best: LyricsCandidate | null = null;
  for await (const event of guestLyricsEvents(hint, signal)) {
    if (event.type === "provider" && event.status === "found") {
      if (!best || event.candidate.quality.total > best.quality.total)
        best = event.candidate;
    }
  }
  return best ? { provider: best.provider, cached: false, candidate: best } : null;
}
