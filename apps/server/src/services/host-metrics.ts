import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ProjectCpuCounters = {
  usageNanoseconds: number;
  sampledAtMs: number;
};

export type HostMetricSnapshot = {
  collectedAt: string;
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
};

type CgroupMembership = {
  version: 1 | 2;
  cpuPath: string;
  memoryPath: string;
};

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function finiteNumber(value: string): number | null {
  if (value.trim() === "max") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseCpuCount(content: string): number {
  const count = content.split(/\r?\n/).filter((line) => /^cpu\d+\s/.test(line)).length;
  if (count <= 0) throw new Error("Host CPU count is unavailable");
  return count;
}

export function projectCpuUsagePercent(
  previous: ProjectCpuCounters,
  current: ProjectCpuCounters,
  cpuCount: number,
): number {
  const usageDelta = current.usageNanoseconds - previous.usageNanoseconds;
  const elapsedNanoseconds = (current.sampledAtMs - previous.sampledAtMs) * 1_000_000;
  if (usageDelta < 0 || elapsedNanoseconds <= 0 || cpuCount <= 0) return 0;
  return boundedPercent((usageDelta / elapsedNanoseconds / cpuCount) * 100);
}

export function parseCgroupMembership(content: string, expectedParent: string): CgroupMembership {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const unified = lines.find((line) => line.startsWith("0::"));
  if (unified) {
    const parentPath = expectedParentPath(unified.slice(3), expectedParent);
    return { version: 2, cpuPath: parentPath, memoryPath: parentPath };
  }

  const entries = lines.map((line) => {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) return { controllers: [] as string[], path: "" };
    return {
      controllers: line.slice(first + 1, second).split(","),
      path: line.slice(second + 1),
    };
  });
  const cpu = entries.find((entry) => entry.controllers.includes("cpuacct"));
  const memory = entries.find((entry) => entry.controllers.includes("memory"));
  if (!cpu?.path || !memory?.path) throw new Error("Required cgroup controllers are unavailable");
  return {
    version: 1,
    cpuPath: expectedParentPath(cpu.path, expectedParent),
    memoryPath: expectedParentPath(memory.path, expectedParent),
  };
}

function expectedParentPath(membershipPath: string, expectedParent: string): string {
  const parts = membershipPath.split("/").filter(Boolean);
  const parentIndex = parts.lastIndexOf(expectedParent);
  if (parentIndex < 0 || parentIndex === parts.length - 1) {
    throw new Error(`Container is not attached below the expected cgroup parent ${expectedParent}`);
  }
  return `/${parts.slice(0, parentIndex + 1).join("/")}`;
}

function controllerPath(root: string, controller: string | null, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "");
  return controller ? join(root, controller, clean) : join(root, clean);
}

async function readNumber(path: string): Promise<number | null> {
  try {
    return finiteNumber(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function sumChildValues(parentPath: string, fileName: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  const values = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readNumber(join(parentPath, entry.name, fileName))));
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

async function cgroupMembership(procRoot: string, cgroupRoot: string, expectedParent: string) {
  const membership = parseCgroupMembership(
    await readFile(join(procRoot, "self", "cgroup"), "utf8"),
    expectedParent,
  );
  if (membership.version === 2) {
    const parent = controllerPath(cgroupRoot, null, membership.cpuPath);
    return { membership, cpuParent: parent, memoryParent: parent };
  }
  return {
    membership,
    cpuParent: controllerPath(cgroupRoot, "cpuacct", membership.cpuPath),
    memoryParent: controllerPath(cgroupRoot, "memory", membership.memoryPath),
  };
}

async function cpuUsageNanoseconds(version: 1 | 2, cpuParent: string): Promise<number> {
  if (version === 1) {
    const usage = await readNumber(join(cpuParent, "cpuacct.usage"));
    if (usage === null) throw new Error("Project CPU cgroup usage is unavailable");
    return usage;
  }
  const stat = await readFile(join(cpuParent, "cpu.stat"), "utf8");
  const usageLine = stat.split(/\r?\n/).find((line) => line.startsWith("usage_usec "));
  const usageMicroseconds = Number(usageLine?.split(/\s+/)[1]);
  if (!Number.isFinite(usageMicroseconds)) throw new Error("Project CPU cgroup usage is unavailable");
  return usageMicroseconds * 1_000;
}

async function memoryCacheBytes(memoryParent: string, key: string): Promise<number> {
  try {
    const stat = await readFile(join(memoryParent, "memory.stat"), "utf8");
    const line = stat.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key} `));
    const value = Number(line?.split(/\s+/)[1]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function memoryUsage(version: 1 | 2, memoryParent: string) {
  if (version === 1) {
    const [rawUsedBytes, cacheBytes, totalBytes, memswUsedBytes, memswLimitBytes] = await Promise.all([
      readNumber(join(memoryParent, "memory.usage_in_bytes")),
      memoryCacheBytes(memoryParent, "total_inactive_file"),
      sumChildValues(memoryParent, "memory.limit_in_bytes"),
      readNumber(join(memoryParent, "memory.memsw.usage_in_bytes")),
      sumChildValues(memoryParent, "memory.memsw.limit_in_bytes"),
    ]);
    if (rawUsedBytes === null || totalBytes <= 0) {
      throw new Error("Project memory cgroup usage is unavailable");
    }
    return {
      memoryUsedBytes: Math.max(0, rawUsedBytes - cacheBytes),
      memoryLimitBytes: totalBytes,
      swapUsedBytes: Math.max(0, (memswUsedBytes ?? rawUsedBytes) - rawUsedBytes),
      swapLimitBytes: Math.max(0, memswLimitBytes - totalBytes),
    };
  }

  const [rawMemoryUsedBytes, cacheBytes, memoryLimitBytes, swapUsedBytes, swapLimitBytes] = await Promise.all([
    readNumber(join(memoryParent, "memory.current")),
    memoryCacheBytes(memoryParent, "inactive_file"),
    sumChildValues(memoryParent, "memory.max"),
    readNumber(join(memoryParent, "memory.swap.current")),
    sumChildValues(memoryParent, "memory.swap.max"),
  ]);
  if (rawMemoryUsedBytes === null || memoryLimitBytes <= 0) {
    throw new Error("Project memory cgroup usage is unavailable");
  }
  return {
    memoryUsedBytes: Math.max(0, rawMemoryUsedBytes - cacheBytes),
    memoryLimitBytes,
    swapUsedBytes: swapUsedBytes ?? 0,
    swapLimitBytes,
  };
}

function resourceUsage(usedBytes: number, totalBytes: number) {
  const normalizedUsed = Math.max(0, usedBytes);
  const availableBytes = Math.max(0, totalBytes - normalizedUsed);
  return {
    totalBytes,
    usedBytes: normalizedUsed,
    availableBytes,
    percent: totalBytes > 0 ? boundedPercent((normalizedUsed / totalBytes) * 100) : 0,
  };
}

export async function readProjectCpuCounters(input: {
  procRoot: string;
  cgroupRoot: string;
  expectedParent: string;
}): Promise<ProjectCpuCounters> {
  const { membership, cpuParent } = await cgroupMembership(
    input.procRoot,
    input.cgroupRoot,
    input.expectedParent,
  );
  return {
    usageNanoseconds: await cpuUsageNanoseconds(membership.version, cpuParent),
    sampledAtMs: Date.now(),
  };
}

export async function collectHostMetrics(input: {
  procRoot: string;
  cgroupRoot: string;
  expectedParent: string;
  previousCpu: ProjectCpuCounters;
}): Promise<{ snapshot: HostMetricSnapshot; cpu: ProjectCpuCounters }> {
  const [{ membership, cpuParent, memoryParent }, cpuCount] = await Promise.all([
    cgroupMembership(input.procRoot, input.cgroupRoot, input.expectedParent),
    readFile(join(input.procRoot, "stat"), "utf8").then(parseCpuCount),
  ]);
  const [usageNanoseconds, memory] = await Promise.all([
    cpuUsageNanoseconds(membership.version, cpuParent),
    memoryUsage(membership.version, memoryParent),
  ]);
  const cpu = { usageNanoseconds, sampledAtMs: Date.now() };
  return {
    cpu,
    snapshot: {
      collectedAt: new Date().toISOString(),
      cpuPercent: projectCpuUsagePercent(input.previousCpu, cpu, cpuCount),
      memory: resourceUsage(memory.memoryUsedBytes, memory.memoryLimitBytes),
      swap: resourceUsage(memory.swapUsedBytes, memory.swapLimitBytes),
    },
  };
}
