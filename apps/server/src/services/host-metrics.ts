import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";

export type CpuCounters = {
  idle: number;
  total: number;
};

export type HostMetricSnapshot = {
  collectedAt: string;
  uptimeSeconds: number;
  load: [number, number, number];
  cpuPercent: number;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percent: number;
  };
  swap: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percent: number;
  };
  storage: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percent: number;
    inodesTotal: number;
    inodesUsed: number;
    inodesAvailable: number;
    inodePercent: number;
  };
};

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function parseCpuCounters(content: string): CpuCounters {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith("cpu "));
  if (!line) throw new Error("Host CPU counters are unavailable");
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 5 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Host CPU counters are invalid");
  }
  const [user = 0, nice = 0, system = 0, idle = 0, ioWait = 0, irq = 0, softIrq = 0, steal = 0] = values;
  return {
    idle: idle + ioWait,
    total: user + nice + system + idle + ioWait + irq + softIrq + steal,
  };
}

export function cpuUsagePercent(previous: CpuCounters, current: CpuCounters): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return boundedPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function parseMemInfo(content: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
  }
  return values;
}

function resourceUsage(totalBytes: number, availableBytes: number) {
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    percent: totalBytes > 0 ? boundedPercent((usedBytes / totalBytes) * 100) : 0,
  };
}

export async function readCpuCounters(procRoot: string): Promise<CpuCounters> {
  return parseCpuCounters(await readFile(join(procRoot, "stat"), "utf8"));
}

export async function collectHostMetrics(input: {
  procRoot: string;
  storageRoot: string;
  previousCpu: CpuCounters;
}): Promise<{ snapshot: HostMetricSnapshot; cpu: CpuCounters }> {
  const [cpuContent, memContent, uptimeContent, loadContent, storage] = await Promise.all([
    readFile(join(input.procRoot, "stat"), "utf8"),
    readFile(join(input.procRoot, "meminfo"), "utf8"),
    readFile(join(input.procRoot, "uptime"), "utf8"),
    readFile(join(input.procRoot, "loadavg"), "utf8"),
    statfs(input.storageRoot, { bigint: true }),
  ]);
  const cpu = parseCpuCounters(cpuContent);
  const memory = parseMemInfo(memContent);
  const memoryTotal = memory.get("MemTotal") ?? 0;
  const memoryAvailable = memory.get("MemAvailable") ?? memory.get("MemFree") ?? 0;
  const swapTotal = memory.get("SwapTotal") ?? 0;
  const swapAvailable = memory.get("SwapFree") ?? 0;
  const blockSize = storage.bsize;
  const totalBytes = Number(storage.blocks * blockSize);
  const availableBytes = Number(storage.bavail * blockSize);
  const usedBytes = Math.max(0, Number((storage.blocks - storage.bfree) * blockSize));
  const reportedInodesTotal = Number(storage.files);
  const reportedInodesAvailable = Number(storage.ffree);
  const inodeStatsReliable =
    reportedInodesTotal > 0 &&
    reportedInodesAvailable >= 0 &&
    reportedInodesAvailable <= reportedInodesTotal;
  const inodesTotal = inodeStatsReliable ? reportedInodesTotal : 0;
  const inodesAvailable = inodeStatsReliable ? reportedInodesAvailable : 0;
  const inodesUsed = Math.max(0, inodesTotal - inodesAvailable);
  const loadParts = loadContent.trim().split(/\s+/).slice(0, 3).map(Number);

  return {
    cpu,
    snapshot: {
      collectedAt: new Date().toISOString(),
      uptimeSeconds: Math.max(0, Number(uptimeContent.trim().split(/\s+/)[0] ?? 0)),
      load: [loadParts[0] ?? 0, loadParts[1] ?? 0, loadParts[2] ?? 0],
      cpuPercent: cpuUsagePercent(input.previousCpu, cpu),
      memory: resourceUsage(memoryTotal, memoryAvailable),
      swap: resourceUsage(swapTotal, swapAvailable),
      storage: {
        totalBytes,
        usedBytes,
        availableBytes,
        percent: totalBytes > 0 ? boundedPercent((usedBytes / totalBytes) * 100) : 0,
        inodesTotal,
        inodesUsed,
        inodesAvailable,
        inodePercent: inodesTotal > 0
          ? boundedPercent((inodesUsed / inodesTotal) * 100)
          : 0,
      },
    },
  };
}
