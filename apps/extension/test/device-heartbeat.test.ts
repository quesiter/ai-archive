import { setImmediate as yieldIO } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/packaged-origin", () => ({ packagedServerOrigin: () => "https://archive.example" }));
import { startDeviceHeartbeat } from "../lib/device-heartbeat";

let auth: Record<string, unknown>;
let alarm: (value: { name: string }) => void;
let changed: (value: Record<string, unknown>, area: string) => void;
let fetchMock: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
beforeEach(() => {
  auth = { deviceToken: "test-device-token", serverUrl: "https://archive.example" };
  fetchMock=vi.fn(async () => new Response("{}", { status: 200 })); create=vi.fn();
  vi.stubGlobal("fetch",fetchMock);
  vi.stubGlobal("browser", {
    runtime: { getManifest: () => ({ version: "2.4.88" }), getPlatformInfo: async () => ({ os: "win" }) },
    storage: { local: { get: async () => auth }, onChanged: { addListener: (fn: typeof changed) => { changed=fn; } } },
    alarms: { get: vi.fn(async () => undefined), create, onAlarm: { addListener: (fn: typeof alarm) => { alarm=fn; } } },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it("reports the actual manifest version without inferring it from a site adapter", async () => {
  startDeviceHeartbeat();await yieldIO();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url,options]=fetchMock.mock.calls[0]!;
  expect(url).toBe("https://archive.example/api/v1/devices/heartbeat");
  expect(JSON.parse(options.body)).toEqual({ clientVersion: "V2.4.88", os: "Chrome/win", trackedFiles: 0, skippedFiles: 0 });
  expect(options.headers.Authorization).toBe("Bearer test-device-token");
  expect(create).toHaveBeenCalledWith("device-version-heartbeat", { periodInMinutes: 5 });
});

it("does not send a token before pairing or across a configured-server change", async () => {
  auth={deviceToken:"test-device-token",serverUrl:"https://old.example"};
  startDeviceHeartbeat();await yieldIO();expect(fetchMock).not.toHaveBeenCalled();
  auth={};changed({deviceToken:{}},"local");await yieldIO();expect(fetchMock).not.toHaveBeenCalled();
  auth={deviceToken:"new-token",serverUrl:"https://archive.example"};
  changed({deviceToken:{}},"local");await yieldIO();expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("preserves an existing wake-up alarm and coalesces concurrent reports", async () => {
  (browser.alarms.get as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "device-version-heartbeat" });
  let finish!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish=resolve; }));
  startDeviceHeartbeat();await yieldIO();
  alarm({name:"device-version-heartbeat"});changed({deviceToken:{}},"local");await yieldIO();
  expect(create).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
  finish(new Response("{}"));await yieldIO();
  alarm({name:"device-version-heartbeat"});await yieldIO();expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retries optional telemetry after a network failure and ignores unrelated events", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));
  startDeviceHeartbeat();await yieldIO();
  alarm({name:"another-alarm"});changed({batchStatus:{}},"local");changed({deviceToken:{}},"sync");await yieldIO();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  alarm({name:"device-version-heartbeat"});await yieldIO();expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not duplicate heartbeat ownership in split incognito", async () => {
  vi.stubGlobal("browser",{extension:{inIncognitoContext:true}});
  startDeviceHeartbeat();await yieldIO();expect(fetchMock).not.toHaveBeenCalled();
});
