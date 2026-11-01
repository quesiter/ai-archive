import { describe, expect, it } from "vitest";
import { sourceDeviceFilterLabel, sourceDeviceLabel } from "./source-device.js";

describe("conversation source labels", () => {
  it("labels file imports in both conversation lists and details", () => {
    expect(sourceDeviceLabel({ sourceDeviceName: null, triggerReason: "historical_import" })).toBe("历史文件导入");
    expect(sourceDeviceLabel({ sourceDevice: null, adapterVersion: "chat-memo-text-v1" })).toBe("历史文件导入");
  });
  it("keeps real device attribution when an imported conversation is later captured", () => {
    expect(sourceDeviceLabel({ sourceDeviceName: "QML-Chrome", triggerReason: "historical_import" })).toBe("QML-Chrome");
    expect(sourceDeviceLabel({ sourceDevice: { name: "QL" }, adapterVersion: "chat-memo-text-v1" })).toBe("QL");
  });
  it("does not mistake local agent uploads for historical file imports", () => {
    expect(sourceDeviceLabel({ adapterVersion: "codex-jsonl-v6", triggerReason: "local_file_rewritten" })).toBe("未记录设备");
    expect(sourceDeviceLabel(null)).toBe("未记录设备");
  });
  it("retains meaningful filter labels when a saved filter has no remaining matches", () => {
    expect(sourceDeviceFilterLabel("historical_import")).toBe("历史文件导入");
    expect(sourceDeviceFilterLabel("unrecorded")).toBe("未记录设备");
    expect(sourceDeviceFilterLabel("name:qml-chrome")).toBe("qml-chrome");
  });
});
