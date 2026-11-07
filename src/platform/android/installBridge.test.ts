// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

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

    await api.authSession!.set({ accessToken: "a", refreshToken: "r" });
    expect(api.authSession!.get()?.accessToken).toBe("a");
    await api.authSession!.set(null);
    expect(api.authSession!.get()).toBeNull();
  });
});
