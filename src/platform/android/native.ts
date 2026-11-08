// Network helpers for the Android build. Inside the Capacitor shell requests go through
// the native HTTP layer (no CORS, binary bodies); in a plain browser and in tests they
// fall back to fetch.
import { Capacitor, CapacitorHttp } from "@capacitor/core";

export function isAndroidApp(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("android-app")
  );
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
}

export async function nativeGetText(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  abortIfNeeded(signal);
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers,
      responseType: "text",
      connectTimeout: 12_000,
      readTimeout: 20_000,
    });
    abortIfNeeded(signal);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function nativeGetJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const text = await nativeGetText(url, headers, signal);
  // some endpoints answer json with a text/html content type and stray bytes in front
  const start = text.search(/[[{]/);
  return JSON.parse(start > 0 ? text.slice(start) : text) as T;
}

export async function nativeGetBlob(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Blob> {
  abortIfNeeded(signal);
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers,
      responseType: "blob",
      connectTimeout: 15_000,
      readTimeout: 60_000,
    });
    abortIfNeeded(signal);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const type =
      (res.headers?.["Content-Type"] ?? res.headers?.["content-type"]) ||
      "application/octet-stream";
    const bin = atob(String(res.data));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
