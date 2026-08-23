import { describe, expect, it } from "vitest";
import { operationLogDeviceId } from "../src/routes/logs.js";

describe("operation log device source", () => {
  it("prefers the capture device stored in metadata", () => {
    expect(operationLogDeviceId({
      entityType: "conversation",
      entityId: "conversation-id",
      metadata: { deviceId: "device-id" },
    })).toBe("device-id");
  });

  it("uses a device entity for device lifecycle logs", () => {
    expect(operationLogDeviceId({
      entityType: "device",
      entityId: "paired-device-id",
      metadata: {},
    })).toBe("paired-device-id");
  });

  it("leaves server-side jobs without a device source", () => {
    expect(operationLogDeviceId({
      entityType: "report",
      entityId: "report-id",
      metadata: {},
    })).toBeNull();
  });
});
