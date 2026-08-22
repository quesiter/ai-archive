import { describe, expect, it } from "vitest";
import {
  cpuUsagePercent,
  parseCpuCounters,
  parseMemInfo,
} from "../src/services/host-metrics.js";
import { systemAlerts } from "../src/services/system-status.js";

describe("host metrics", () => {
  it("parses aggregate CPU counters and calculates usage", () => {
    const previous = parseCpuCounters("cpu  100 10 30 400 20 5 5 0 0 0\n");
    const current = parseCpuCounters("cpu  130 10 50 460 30 5 5 0 0 0\n");
    expect(previous).toEqual({ idle: 420, total: 570 });
    expect(cpuUsagePercent(previous, current)).toBe(41.7);
  });

  it("converts proc memory values from KiB to bytes", () => {
    const memory = parseMemInfo("MemTotal:       1024 kB\nMemAvailable:    256 kB\nSwapTotal:       512 kB\n");
    expect(memory.get("MemTotal")).toBe(1024 * 1024);
    expect(memory.get("MemAvailable")).toBe(256 * 1024);
  });

  it("raises warning and critical alerts at resource thresholds", () => {
    expect(systemAlerts({
      cpuPercent: 30,
      memory: { percent: 86.2 },
      swap: { totalBytes: 0, percent: 100 },
      storage: { percent: 96, inodePercent: 10 },
    })).toEqual([
      { level: "warning", metric: "memory", message: "内存使用率 86.2%" },
      { level: "critical", metric: "disk", message: "磁盘使用率 96.0%" },
    ]);
  });
});
