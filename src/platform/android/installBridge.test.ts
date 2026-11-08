// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// the real core would replace the fake window.Capacitor set below
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: {},
}));

describe("android bridge", () => {
  it("installs only inside a native Capacitor shell and signs requests", async () => {
    expect(window.linerElectron).toBeUndefined();
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
    };
    await import("./installBridge");
    const api = window.linerElectron!;
    expect(api.platform).toBe("android");

    const signed = await api.signRequest({
      method: "get",
      path: "/v1/health",
      body: null,
      timestamp: 1_700_000_000,
    });
    expect(signed.error).toBeUndefined();
    expect(signed.signature).toBeTruthy();
    expect(signed.nonce).toMatch(/^[0-9a-f]{16}$/);

    // permanent local guest session: no account server on android
    expect((api.authSession!.get() as { user?: { id?: string } })?.user?.id).toBe("guest");
    await api.authSession!.set(null);
    expect(api.authSession!.get()).not.toBeNull();
    const refreshed = await api.authSession!.refresh({ apiBaseUrl: "https://x" });
    expect(refreshed.outcome).toBe("refreshed");
    expect(document.documentElement.classList.contains("android-app")).toBe(true);
  });
});
