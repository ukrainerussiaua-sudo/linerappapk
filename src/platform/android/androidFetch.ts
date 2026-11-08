// window.fetch replacement for the Capacitor shell.
//
// The desktop app relies on Electron main to (a) lift CORS and (b) rewrite the
// Origin / Referer / User-Agent headers for YouTube hosts (x-origin and
// x-liner-user-agent are only markers for that rewrite). A WebView has neither,
// so cross-origin http(s) requests are sent through the native HTTP stack and
// the same header rules are applied here.
import { CapacitorHttp } from "@capacitor/core";

const UA_MARKER = "x-liner-user-agent";
const CHUNK = 1024 * 1024;

function youtubeOriginFor(url: string): string {
  return url.includes("://www.youtube.com/")
    ? "https://www.youtube.com"
    : "https://music.youtube.com";
}

function isYoutubeHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function toBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildHeaders(url: string, init: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  let ua: string | undefined;
  init.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === UA_MARKER) ua = value;
    else if (lower !== "origin" && lower !== "referer") out[name] = value;
  });
  if (isYoutubeHost(url)) {
    const origin = youtubeOriginFor(url);
    out["Origin"] = origin;
    out["Referer"] = `${origin}/`;
  }
  if (ua) out["User-Agent"] = ua;
  return out;
}

function sameOrigin(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    return (
      u.origin === window.location.origin ||
      (u.protocol !== "http:" && u.protocol !== "https:")
    );
  } catch {
    return true;
  }
}

function lookup(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === lower) return headers[key];
  return undefined;
}

interface NativeResult {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
}

async function nativeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  data: unknown,
  signal?: AbortSignal,
): Promise<NativeResult> {
  if (signal?.aborted) throw abortError(signal);
  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    responseType: "blob",
    connectTimeout: 15_000,
    readTimeout: 60_000,
  });
  if (signal?.aborted) throw abortError(signal);
  const raw = typeof res.data === "string" ? res.data : "";
  return {
    status: res.status,
    headers: (res.headers ?? {}) as Record<string, string>,
    bytes: raw ? toBytes(raw) : new Uint8Array(0),
  };
}

function bodyOf(
  body: BodyInit | null | undefined,
  contentType: string | undefined,
): { ok: boolean; data?: unknown } {
  if (body == null) return { ok: true };
  if (typeof body === "string") {
    if (contentType && /json/i.test(contentType)) {
      try {
        return { ok: true, data: JSON.parse(body) };
      } catch {
        return { ok: true, data: body };
      }
    }
    return { ok: true, data: body };
  }
  if (body instanceof URLSearchParams) return { ok: true, data: body.toString() };
  return { ok: false };
}

export function installAndroidFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : undefined;
    if (!url || sameOrigin(url)) return original(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = bodyOf(init?.body, headers.get("content-type") ?? undefined);
    if (!body.ok) return original(input, init);
    const result = await nativeRequest(
      url,
      method,
      buildHeaders(url, headers),
      body.data,
      init?.signal ?? undefined,
    );
    const noBody = result.status === 204 || result.status === 304;
    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(result.headers)) {
      try {
        responseHeaders.set(k, String(v));
      } catch {
        // ignore header names the Headers class rejects
      }
    }
    // the body is already decoded by the native layer
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(noBody ? null : result.bytes, {
      status: result.status,
      headers: responseHeaders,
    });
  };
}

// googlevideo has no CORS headers and the player needs a same-origin source, so
// remote audio is pulled down through the native layer in ranged chunks.
export async function downloadAudioBlob(
  url: string,
  mimeType: string,
  signal?: AbortSignal,
  contentLength?: number,
): Promise<Blob> {
  const headers = buildHeaders(url, new Headers());
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let total = contentLength && contentLength > 0 ? contentLength : Infinity;
  while (offset < total) {
    const end = offset + CHUNK - 1;
    const res = await nativeRequest(
      url,
      "GET",
      { ...headers, Range: `bytes=${offset}-${end}` },
      undefined,
      signal,
    );
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const range = lookup(res.headers, "content-range");
    const size = range ? Number(range.split("/")[1]) : NaN;
    if (Number.isFinite(size)) total = size;
    parts.push(res.bytes);
    // 200 means the server ignored Range and sent everything
    if (res.status === 200) {
      total = res.bytes.length;
      offset = res.bytes.length;
      if (parts.length > 1) parts.splice(0, parts.length - 1);
      break;
    }
    offset += res.bytes.length;
    if (res.bytes.length === 0) break;
    if (!Number.isFinite(total) && res.bytes.length < CHUNK) break;
  }
  return new Blob(parts, { type: mimeType || "audio/mp4" });
}
