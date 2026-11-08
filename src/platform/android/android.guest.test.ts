// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import CryptoJS from "crypto-js";
import {
  decryptMediaUrl,
  mapSong,
  recallMedia,
  toCover,
} from "./saavn/saavnApi";
import { saavnQualityUrls } from "./saavn/saavnStream";
import { geekedToRichsync, lrcFromLines } from "./lyrics/guestLyrics";
import { parseRawLyrics } from "@/features/lyrics/engine/lyricsParser";
import {
  handleGuestRequest,
  resetGuestStoreForTests,
} from "./guest/guestBackend";

const track = {
  id: "sv:abc",
  title: "Song",
  artists: [{ id: "sv:1", name: "Artist" }],
  durationMs: 1000,
};

describe("saavn", () => {
  it("decrypts the media url the way the site encrypts it", () => {
    const plain = "http://aac.saavncdn.com/123/abc_96.mp4";
    const encrypted = CryptoJS.DES.encrypt(
      plain,
      CryptoJS.enc.Utf8.parse("38346591"),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
    ).ciphertext.toString(CryptoJS.enc.Base64);
    expect(decryptMediaUrl(encrypted)).toBe(plain);
  });

  it("maps a song and remembers its media", () => {
    const mapped = mapSong({
      id: "IbjMsTPa",
      title: "Rock &amp; Roll",
      image: "https://c.saavncdn.com/1/Cover-150x150.jpg",
      explicit_content: "1",
      more_info: {
        duration: "259",
        album: "The Album",
        album_id: "42",
        encrypted_media_url: "xyz",
        "320kbps": "true",
        artistMap: {
          primary_artists: [{ id: "9", name: "Some Artist" }],
        },
      },
    });
    expect(mapped.id).toBe("sv:IbjMsTPa");
    expect(mapped.title).toBe("Rock & Roll");
    expect(mapped.durationMs).toBe(259000);
    expect(mapped.artists).toEqual([{ id: "sv:9", name: "Some Artist" }]);
    expect(mapped.album).toEqual({ id: "sv:42", title: "The Album" });
    expect(mapped.explicit).toBe(true);
    expect(mapped.cover?.url).toBe("https://c.saavncdn.com/1/Cover-500x500.jpg");
    expect(recallMedia("sv:IbjMsTPa")).toEqual({ encrypted: "xyz", has320: true });
  });

  it("builds quality fallbacks and upgrades http", () => {
    expect(saavnQualityUrls("http://aac.saavncdn.com/x/y_96.mp4", true)).toEqual([
      "https://aac.saavncdn.com/x/y_320.mp4",
      "https://aac.saavncdn.com/x/y_160.mp4",
      "https://aac.saavncdn.com/x/y_96.mp4",
    ]);
    expect(saavnQualityUrls("https://a/x_96.mp4", false)).toHaveLength(2);
  });

  it("ignores covers it cannot size", () => {
    expect(toCover(undefined)).toBeUndefined();
  });
});

describe("lyrics conversion", () => {
  it("turns word timings into richsync the existing parser understands", () => {
    const rich = geekedToRichsync([
      {
        time: 5000,
        syllabus: [
          { time: 5000, duration: 400, text: "Hello " },
          { time: 5400, duration: 600, text: "world" },
        ],
      },
      { time: 9000, syllabus: [{ time: 9000, duration: 500, text: "Again" }] },
    ])!;
    const parsed = parseRawLyrics(rich, "richsync");
    expect(parsed.braccatoLyrics).toHaveLength(2);
    const first = parsed.braccatoLyrics[0]!;
    expect(first.startTimeMs).toBe(5000);
    expect(first.parts?.map((p) => p.startTimeMs)).toEqual([5000, 5400]);
    expect(first.parts?.map((p) => p.words)).toEqual(["Hello ", "world"]);
  });

  it("writes lrc the parser reads back", () => {
    const lrc = lrcFromLines([
      { timeMs: 1500, text: "one" },
      { timeMs: 65_250, text: "two" },
    ]);
    expect(lrc).toBe("[00:01.50]one\n[01:05.25]two");
    const parsed = parseRawLyrics(lrc, "lrc");
    expect(parsed.syncedLines.map((l) => l.timeMs)).toEqual([1500, 65250]);
  });
});

describe("guest library", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGuestStoreForTests();
  });

  it("serves the guest user", () => {
    expect((handleGuestRequest({ method: "GET", path: "/v1/me" }) as any).id).toBe("guest");
  });

  it("likes and unlikes tracks", () => {
    handleGuestRequest({ method: "PUT", path: "/v1/me/library/tracks/sv%3Aabc", body: { track } });
    const liked = handleGuestRequest({ method: "GET", path: "/v1/me/library/tracks?limit=10" }) as any;
    expect(liked.items.map((i: any) => i.track.id)).toEqual(["sv:abc"]);
    handleGuestRequest({ method: "DELETE", path: "/v1/me/library/tracks/sv%3Aabc" });
    expect((handleGuestRequest({ method: "GET", path: "/v1/me/library/tracks" }) as any).items).toEqual([]);
  });

  it("keeps playlists, tracks and ordering", () => {
    const created = handleGuestRequest({
      method: "POST",
      path: "/v1/me/playlists",
      body: { title: "Mine" },
    }) as any;
    const id = created.id;
    handleGuestRequest({ method: "POST", path: `/v1/me/playlists/${id}/tracks/sv%3Aabc`, body: { track } });
    handleGuestRequest({
      method: "POST",
      path: `/v1/me/playlists/${id}/tracks`,
      body: { tracks: [{ ...track, id: "sv:def" }] },
    });
    const read = handleGuestRequest({ method: "GET", path: `/v1/me/playlists/${id}?compact=true` }) as any;
    expect(read.items.map((i: any) => i.track.id)).toEqual(["sv:abc", "sv:def"]);
    expect(read.trackCount).toBe(2);
    const [first, second] = read.items;
    handleGuestRequest({
      method: "POST",
      path: `/v1/me/playlists/${id}/items/${second.id}/move`,
      body: { beforeItemId: first.id, revision: read.playlist.revision },
    });
    const moved = handleGuestRequest({ method: "GET", path: `/v1/me/playlists/${id}` }) as any;
    expect(moved.items.map((i: any) => i.track.id)).toEqual(["sv:def", "sv:abc"]);
    const list = handleGuestRequest({ method: "GET", path: "/v1/me/playlists" }) as any;
    expect(list.items[0].trackCount).toBe(2);
    handleGuestRequest({ method: "DELETE", path: `/v1/me/playlists/${id}` });
    expect((handleGuestRequest({ method: "GET", path: "/v1/me/playlists" }) as any).items).toEqual([]);
  });

  it("saves collections in the shape the library expects", () => {
    handleGuestRequest({
      method: "PUT",
      path: "/v1/me/library/albums/sv%3A1",
      body: { snapshot: { title: "Album" } },
    });
    const res = handleGuestRequest({ method: "GET", path: "/v1/me/library/albums" }) as any;
    expect(res.items[0].album).toMatchObject({ id: "sv:1", title: "Album" });
    expect(res.items[0].savedAt).toBeTruthy();
  });

  it("answers unknown server routes with a 404", () => {
    expect(() => handleGuestRequest({ method: "GET", path: "/v1/users/someone" })).toThrow();
  });
});
