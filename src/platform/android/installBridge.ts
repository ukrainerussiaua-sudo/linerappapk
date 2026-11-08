// Android (Capacitor) replacement for the Electron preload bridge.
//
// The desktop app keeps request signing and the auth session in the Electron
// main process and exposes them as window.linerElectron. Inside the Capacitor
// WebView there is no main process, so this module installs a renderer-only
// implementation of the parts the app needs to work (signing, auth session,
// server clock) and harmless no-ops for the desktop-only features (window
// controls, overlay, Discord, updater, touch bar, local files, ...).
//
// It does nothing outside a native Capacitor shell, so the desktop build is
// unaffected.
import { SIGNER_WASM_BASE64 } from "../../../electron/signer";
import type { LinerElectronApi } from "../../../electron/preload";
<<<<<<< HEAD
=======
import { installAndroidFetch } from "./androidFetch";
>>>>>>> e9cee71 (youtube music + soundcloud)
import { GUEST_USER } from "./guest/guestBackend";
import {
  savedGetLyrics,
  savedList,
  savedRemove,
  savedRemoveAll,
  savedSave,
  savedSetLyrics,
  savedUsage,
} from "./savedStore";

type Capacitorish = { isNativePlatform?: () => boolean };

type Session = {
  accessToken: string;
  refreshToken: string;
  user?: unknown;
  [key: string]: unknown;
};

type RefreshResult = {
  outcome: "refreshed" | "rotated" | "signed_out" | "transient" | "no_session";
  session: Session | null;
  reason?: string;
};

interface WasmSignerExports {
  liner_alloc: (len: number) => number;
  liner_dealloc: (ptr: number, len: number) => void;
  liner_get_result_ptr: () => number;
  liner_get_result_len: () => number;
  liner_sign_cover_url: (ptr: number, len: number) => number;
  liner_sign_request: (...args: [...number[], bigint, number, number]) => number;
  liner_sign_monitor_request: (
    ...args: [...number[], bigint, number, number]
  ) => number;
  liner_sign_raw_payload: (ptr: number, len: number) => number;
  memory: WebAssembly.Memory;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let wasm: WasmSignerExports | null = null;
let serverOffsetMs = 0;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getWasm(): WasmSignerExports {
  if (wasm) return wasm;
  const mod = new WebAssembly.Module(
    base64ToBytes(SIGNER_WASM_BASE64) as BufferSource,
  );
  wasm = new WebAssembly.Instance(mod, {}).exports as unknown as WasmSignerExports;
  return wasm;
}

function put(w: WasmSignerExports, bytes: Uint8Array) {
  const ptr = w.liner_alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length, free: () => w.liner_dealloc(ptr, bytes.length) };
}

function readResult(w: WasmSignerExports): string {
  const ptr = w.liner_get_result_ptr();
  const len = w.liner_get_result_len();
  if (!ptr || len === 0) return "";
  return decoder.decode(new Uint8Array(w.memory.buffer, ptr, len).slice());
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function adjustedTimestamp(): number {
  return Math.floor((Date.now() + serverOffsetMs) / 1000);
}

type SignInput = {
  method: string;
  path: string;
  body?: string | null;
  timestamp?: number;
};

function signWith(
  fn: "liner_sign_request" | "liner_sign_monitor_request",
  input: SignInput,
) {
  const w = getWasm();
  const timestamp = input.timestamp ?? adjustedTimestamp();
  const nonce = randomNonce();
  const m = put(w, encoder.encode(input.method));
  const p = put(w, encoder.encode(input.path));
  const b = put(w, encoder.encode(input.body ?? ""));
  const n = put(w, encoder.encode(nonce));
  try {
    const code = w[fn](
      m.ptr,
      m.len,
      p.ptr,
      p.len,
      b.ptr,
      b.len,
      BigInt(timestamp),
      n.ptr,
      n.len,
    );
    if (code !== 0) throw new Error(`wasm ${fn} failed with code ${code}`);
    return { signature: readResult(w), timestamp, nonce };
  } finally {
    m.free();
    p.free();
    b.free();
    n.free();
  }
}

function safeSign(
  fn: "liner_sign_request" | "liner_sign_monitor_request",
  input: SignInput,
) {
  try {
    return Promise.resolve(signWith(fn, input));
  } catch (err) {
    return Promise.resolve({ error: String((err as Error)?.message ?? err) });
  }
}

function signCoverUrl(payload: string): string {
  const w = getWasm();
  const buf = put(w, encoder.encode(payload));
  try {
    const code = w.liner_sign_cover_url(buf.ptr, buf.len);
    if (code !== 0) throw new Error(`wasm sign_cover_url failed: ${code}`);
    return readResult(w);
  } finally {
    buf.free();
  }
}

function signRawPayload(payload: number[] | Uint8Array): string {
  const w = getWasm();
  const buf = put(w, Uint8Array.from(payload));
  try {
    const code = w.liner_sign_raw_payload(buf.ptr, buf.len);
    if (code !== 0) throw new Error(`wasm sign_raw_payload failed: ${code}`);
    return readResult(w);
  } finally {
    buf.free();
  }
}

function syncTime(dateHeaderOrMs: string | number): number {
  const serverMs =
    typeof dateHeaderOrMs === "number"
      ? dateHeaderOrMs
      : Date.parse(dateHeaderOrMs);
  if (!Number.isNaN(serverMs) && serverMs > 0) {
    serverOffsetMs = serverMs - Date.now();
  }
  return serverOffsetMs;
}

// ---- auth session (localStorage instead of the encrypted main-process file) ----

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    typeof v.refreshToken === "string" &&
    v.refreshToken.length > 0
  );
}

function sessionStore(key: string) {
  const listeners = new Set<(s: Session | null) => void>();
  const read = (): Session | null => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const write = (next: Session | null) => {
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      // storage unavailable: session stays in memory only via listeners
    }
    listeners.forEach((l) => l(next));
  };
  return {
    get: read,
    set: async (next: unknown) => {
      const session = isSession(next) ? next : null;
      write(session);
      return session;
    },
    onChange: (cb: (s: Session | null) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    write,
  };
}

const DEAD_REFRESH_CODES = new Set([
  "INVALID_REFRESH_TOKEN",
  "REFRESH_SESSION_EXPIRED",
]);
const REFRESH_PATH = "/v1/auth/refresh";

let refreshInFlight: Promise<RefreshResult> | null = null;

function trustedApiBase(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" ||
      (protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(hostname))
    );
  } catch {
    return false;
  }
}

function makeRefresh(store: ReturnType<typeof sessionStore>) {
  return (input: {
    apiBaseUrl: string;
    refreshToken?: string;
  }): Promise<RefreshResult> => {
    const current = store.get();
    if (!current) return Promise.resolve({ outcome: "no_session", session: null });
    if (
      input.refreshToken &&
      input.refreshToken !== current.refreshToken &&
      !refreshInFlight
    ) {
      return Promise.resolve({ outcome: "rotated", session: current });
    }
    if (!trustedApiBase(input.apiBaseUrl)) {
      return Promise.resolve({
        outcome: "transient",
        session: current,
        reason: "untrusted api base url",
      });
    }
    if (!refreshInFlight) {
      refreshInFlight = runRefresh(
        store,
        input.apiBaseUrl.replace(/\/+$/, ""),
        current,
      ).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  };
}

async function runRefresh(
  store: ReturnType<typeof sessionStore>,
  apiBase: string,
  current: Session,
): Promise<RefreshResult> {
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = JSON.stringify({ refreshToken: current.refreshToken });
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    try {
      const s = signWith("liner_sign_request", {
        method: "POST",
        path: REFRESH_PATH,
        body,
      });
      headers = {
        ...headers,
        "x-liner-signature": s.signature,
        "x-liner-timestamp": String(s.timestamp),
        "x-liner-nonce": s.nonce,
      };
    } catch {
      // continue unsigned; the server decides
    }

    let response: Response;
    try {
      response = await fetch(`${apiBase}${REFRESH_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { outcome: "transient", session: store.get(), reason: String(err) };
    }

    const date = response.headers.get("date");
    if (date) syncTime(date);

    if (response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch (err) {
        return { outcome: "transient", session: store.get(), reason: String(err) };
      }
      const next = (data && typeof data === "object" ? data : {}) as Partial<Session>;
      const merged = { ...current, ...next, user: next.user ?? current.user };
      if (!isSession(merged)) {
        return {
          outcome: "transient",
          session: store.get(),
          reason: "malformed refresh response",
        };
      }
      if (store.get()?.refreshToken !== current.refreshToken) {
        return { outcome: "rotated", session: store.get() };
      }
      store.write(merged);
      return { outcome: "refreshed", session: merged };
    }

    let code = "";
    try {
      const err = (await response.json()) as { code?: unknown } | null;
      code = typeof err?.code === "string" ? err.code : "";
    } catch {
      // no json body
    }
    reason = [String(response.status), code].filter(Boolean).join(" ");
    if (response.status !== 401 && response.status !== 403) break;
    if (DEAD_REFRESH_CODES.has(code)) {
      if (store.get()?.refreshToken === current.refreshToken) store.write(null);
      return {
        outcome: store.get() ? "rotated" : "signed_out",
        session: store.get(),
        reason,
      };
    }
  }
  return { outcome: "transient", session: store.get(), reason };
}

// ---- no-op helpers for desktop-only features ----

const noop = () => {};
const unsubscribe = () => noop;
const resolved = <T>(value: T) => () => Promise.resolve(value);

// The Android build never talks to the Liner account server: a permanent local guest
// session keeps the app signed in and the library lives on the device (see guestBackend).
const FAR_FUTURE_MS = Date.UTC(2099, 0, 1);
const GUEST_SESSION: Session = {
  accessToken: "guest.local.token",
  refreshToken: "guest.local.refresh",
  accessTokenExpiresAt: new Date(FAR_FUTURE_MS).toISOString(),
  expiresAt: FAR_FUTURE_MS,
  user: GUEST_USER,
};

function buildApi(): LinerElectronApi {
  const auth = sessionStore("liner.android.auth-session");
  const ytAuth = sessionStore("liner.android.youtube-auth-session");

  const usage = { count: 0, bytes: 0, totalBytes: 0, size: 0 };
  const api = {
    platform: "android",
    isHyprland: false,

    minimize: resolved(undefined),
    toggleMaximize: resolved(undefined),
    toggleFullScreen: resolved(undefined),
    close: resolved(undefined),
    isMaximized: resolved(false),
    isFullScreen: resolved(false),
    onWindowStateChange: unsubscribe,
    onWindowRestored: unsubscribe,
    onWindowMinimized: unsubscribe,
    dragStart: noop,
    dragMove: noop,
    dragEnd: noop,

    signRequest: (input: SignInput) => safeSign("liner_sign_request", input),
    signMonitorRequest: (input: SignInput) =>
      safeSign("liner_sign_monitor_request", input),
    syncServerTime: (v: string | number) => Promise.resolve(syncTime(v)),
    getServerTimeOffset: () => Promise.resolve(serverOffsetMs),
    signCoverUrl: (payload: string) => {
      try {
        return Promise.resolve(signCoverUrl(payload));
      } catch {
        return Promise.resolve(payload);
      }
    },
    signRawPayload: (payload: number[] | Uint8Array) => {
      try {
        return Promise.resolve(signRawPayload(payload));
      } catch {
        return Promise.resolve("");
      }
    },

    authSession: {
      get: () => GUEST_SESSION,
      set: () => Promise.resolve(GUEST_SESSION),
      refresh: () =>
        Promise.resolve<RefreshResult>({
          outcome: "refreshed",
          session: GUEST_SESSION,
        }),
      onChange: auth.onChange,
    },
    youtubeAuthSession: { get: ytAuth.get, set: ytAuth.set },

    onDeeplink: unsubscribe,
    diagnoseNetwork: resolved({}),
    probeNetwork: resolved({}),
    openDownloads: resolved(false),
    openExportFolder: resolved(false),
    setAppIcon: resolved(undefined),
    getAppVersion: resolved(
      typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "android",
    ),
    getCacheStats: resolved({
      cacheSize: 0,
      httpCacheSize: 0,
      codeCacheSize: 0,
      serviceWorkerSize: 0,
      indexedDbSize: 0,
      localStorageSize: 0,
      blobStorageSize: 0,
      cachePath: "",
    }),
    openCacheFolder: resolved(false),
    clearCoversCache: resolved(true),
    clearAudioCache: resolved(true),
    clearHttpCache: resolved(true),

    // no auto-updater on android: install a new APK instead
    checkForUpdates: resolved({ available: false }),
    downloadUpdate: resolved({ success: false }),
    quitAndInstall: resolved(false),
    onUpdateAvailable: unsubscribe,
    onUpdateDownloadProgress: unsubscribe,
    onUpdateDownloaded: unsubscribe,
    onUpdateError: unsubscribe,
    bundleCheck: resolved({ available: false }),
    bundleDownloadAndInstall: resolved({ success: false }),
    bundleHotSwap: resolved(false),
    bundleRollback: resolved(false),
    bundleGetStatus: resolved({
      appVersion: "android",
      bundleVersion: "android",
      isOta: false,
      sha256: null,
      effectivePath: "",
    }),
    onBundleAvailable: unsubscribe,
    onBundleDownloadProgress: unsubscribe,
    onBundleReady: unsubscribe,
    onBundleStamp: unsubscribe,

    touchbarUpdateState: noop,
    onTouchBarAction: unsubscribe,
    sendTouchBarAction: noop,
    getTouchBarInitialState: resolved(null),
    onTouchBarRequestSync: unsubscribe,

    overlayUpdateState: noop,
    onOverlayAction: unsubscribe,
    sendOverlayAction: noop,
    toggleOverlay: resolved(false),
    isOverlayOpen: resolved(false),
    closeOverlay: noop,
    onOverlayState: unsubscribe,
    getOverlayInitialState: resolved(null),
    updateOverlaySettings: noop,
    pauseOverlayShortcuts: noop,
    onOverlaySettingsChanged: unsubscribe,
    onOverlayVisibility: unsubscribe,

    discordUpdateState: noop,
    discordUpdateSettings: noop,
    getDiscordStatus: resolved({ connected: false }),

    mintPoToken: () => Promise.reject(new Error("not available on android")),
    youtubeTvSession: () =>
      Promise.reject(new Error("not available on android")),
    youtubeSolveN: () => Promise.reject(new Error("not available on android")),

    localTracksList: resolved([]),
    localTracksImport: resolved({ imported: [], skipped: [], failed: [] }),
    localTracksPick: resolved(null),
    localTracksRemove: resolved(undefined),
    localTracksRemoveAll: resolved(0),
    localTracksUsage: resolved(usage),
    savedTracksList: () => savedList().catch(() => []),
    savedTracksSave: (input: Parameters<typeof savedSave>[0]) => savedSave(input),
    savedTracksRemove: (ids: string[]) => savedRemove(ids),
    savedTracksRemoveAll: () => savedRemoveAll(),
    savedTracksUsage: () =>
      savedUsage().catch(() => ({ count: 0, bytes: 0, freeBytes: null })),
    savedTracksOpenFolder: resolved(false),
    savedTracksGetLyrics: (id: string) => savedGetLyrics(id).catch(() => null),
    savedTracksSetLyrics: (id: string, state: "found" | "missing", lyrics?: unknown) =>
      savedSetLyrics(id, state, lyrics).catch(() => false),
    pathForFile: () => "",
  };

  return api as unknown as LinerElectronApi;
}

export function installAndroidBridge(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: Capacitorish }).Capacitor;
  if (!cap?.isNativePlatform?.()) return false;
  if (window.linerElectron) return false;
  window.linerElectron = buildApi();
<<<<<<< HEAD
=======
  installAndroidFetch();
>>>>>>> e9cee71 (youtube music + soundcloud)
  document.documentElement.classList.add("android-app");
  return true;
}

installAndroidBridge();
