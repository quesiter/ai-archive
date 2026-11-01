import { packagedServerOrigin } from "./packaged-origin";

const HEARTBEAT_ALARM = "device-version-heartbeat";

/** A manifest build version is independent of each site's adapter version. */
export function startDeviceHeartbeat(): void {
  if (browser.extension?.inIncognitoContext) return;
  let inFlight: Promise<void> | undefined;
  const send = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const auth = await browser.storage.local.get(["deviceToken", "serverUrl"]);
      if (typeof auth.deviceToken !== "string" || !auth.deviceToken || typeof auth.serverUrl !== "string") return;
      const origin = new URL(packagedServerOrigin()).origin;
      // A stale credential from another configured server must never be sent
      // before the regular background migration clears or replaces it.
      if (new URL(auth.serverUrl).origin !== origin) return;
      const version = browser.runtime.getManifest().version;
      const platform = await browser.runtime.getPlatformInfo();
      if (!version) return;
      await fetch(`${origin}/api/v1/devices/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.deviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientVersion: `V${version}`, os: `Chrome/${platform.os}`, trackedFiles: 0, skippedFiles: 0 }),
        signal: AbortSignal.timeout(15_000),
      });
    })().catch(() => {
      // Optional health telemetry must not interrupt captures or queue reports.
      // The persisted alarm will retry after a temporary connection failure.
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === HEARTBEAT_ALARM) void send(); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.deviceToken || changes.serverUrl)) void send();
  });
  void browser.alarms.get(HEARTBEAT_ALARM).then(alarm => {
    if (!alarm) return browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
  }).catch(() => {});
  void send();
}
