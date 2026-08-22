import { describe, expect, it } from "vitest";
import {
  parseCgroupMembership,
  parseCpuCount,
  projectCpuUsagePercent,
} from "../src/services/host-metrics.js";
import { projectStorageAlert, systemAlerts } from "../src/services/system-status.js";

describe("host metrics", () => {
  it("calculates project CPU usage as a share of host CPU capacity", () => {
    expect(projectCpuUsagePercent(
      { usageNanoseconds: 1_000_000_000, sampledAtMs: 1_000 },
      { usageNanoseconds: 3_000_000_000, sampledAtMs: 2_000 },
      4,
    )).toBe(50);
  });

  it("locates the configured project parent in cgroup v1 and v2 memberships", () => {
    expect(parseCgroupMembership([
      "8:cpuacct:/system.slice/docker/ai-conversation-archive/container-id",
      "5:memory:/system.slice/docker/ai-conversation-archive/container-id",
    ].join("\n"), "ai-conversation-archive")).toEqual({
      version: 1,
      cpuPath: "/system.slice/docker/ai-conversation-archive",
      memoryPath: "/system.slice/docker/ai-conversation-archive",
    });
    expect(parseCgroupMembership(
      "0::/docker/ai-conversation-archive/container-id\n",
      "ai-conversation-archive",
    )).toEqual({
      version: 2,
      cpuPath: "/docker/ai-conversation-archive",
      memoryPath: "/docker/ai-conversation-archive",
    });
    expect(() => parseCgroupMembership("0::/docker/container-id\n", "ai-conversation-archive"))
      .toThrow(/expected cgroup parent/);
  });

  it("counts logical CPUs from host proc stat", () => {
    expect(parseCpuCount("cpu  1 2 3 4\ncpu0 1 2 3 4\ncpu1 1 2 3 4\nintr 1\n")).toBe(2);
  });

  it("raises warning and critical alerts at resource thresholds", () => {
    expect(systemAlerts({
      cpuPercent: 30,
      memory: { percent: 86.2 },
      swap: { totalBytes: 0, percent: 100 },
    })).toEqual([
      { level: "warning", metric: "memory", message: "项目内存额度使用率 86.2%" },
    ]);
    expect(projectStorageAlert(null)).toBeNull();
    expect(projectStorageAlert(96)).toEqual({
      level: "critical",
      metric: "storage",
      message: "项目存储预算使用率 96.0%",
    });
  });
});
