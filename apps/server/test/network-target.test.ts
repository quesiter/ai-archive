import { describe, expect, it } from "vitest";
import {
  isPrivateNetworkAddress,
  pinnedLookup,
  withPinnedNetworkDispatcher,
  validateNetworkUrl,
} from "../src/services/network-target.js";
import { validateSettingValue } from "../src/services/settings.js";

describe("outbound network target validation", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "2001:db8::1",
  ])("blocks private or reserved address %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it("allows public IP addresses", () => {
    expect(isPrivateNetworkAddress("1.1.1.1")).toBe(false);
    expect(isPrivateNetworkAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects unsafe schemes and embedded credentials", () => {
    expect(() => validateNetworkUrl("file:///etc/passwd")).toThrow(/HTTP/);
    expect(() => validateNetworkUrl("https://user:pass@example.com/v1")).toThrow(
      /credentials/,
    );
    expect(() => validateNetworkUrl("https://example.com/v1?api_key=secret")).toThrow(
      /query parameters/,
    );
  });

  it("validates persisted endpoint settings", () => {
    expect(validateSettingValue("llm.baseUrl", " https://api.example.com/v1 ")).toBe(
      "https://api.example.com/v1",
    );
    expect(() => validateSettingValue("smtp.port", "70000")).toThrow(/SMTP port/);
    expect(() => validateSettingValue("smtp.host", "https://smtp.example.com")).toThrow(
      /hostname/,
    );
  });

  it("pins socket lookups to the already validated hostname and addresses", async () => {
    const lookup = pinnedLookup({
      hostname: "api.example.com",
      addresses: [{ address: "1.1.1.1", family: 4 }],
    });
    const call = (hostname: string) =>
      new Promise<{ address: string; family: number }>((resolve, reject) => {
        lookup(hostname, { family: 4 }, (error, address, family) => {
          if (error) return reject(error);
          resolve({ address: String(address), family: family ?? 0 });
        });
      });
    await expect(call("api.example.com")).resolves.toEqual({
      address: "1.1.1.1",
      family: 4,
    });
    await expect(call("attacker.example")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });

  it("closes a pinned dispatcher when the operation throws", async () => {
    await expect(
      withPinnedNetworkDispatcher("https://1.1.1.1/v1", async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
  });
});
