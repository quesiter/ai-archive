import { createServer } from "node:http";
import {
  collectHostMetrics,
  readProjectCpuCounters,
  type HostMetricSnapshot,
} from "./services/host-metrics.js";

const port = Number(process.env.HOST_MONITOR_PORT ?? 9091);
const procRoot = process.env.HOST_PROC_ROOT ?? "/host/proc";
const cgroupRoot = process.env.HOST_CGROUP_ROOT ?? "/host/cgroup";
const expectedParent = process.env.HOST_PROJECT_CGROUP ?? "ai-conversation-archive";
const sampleIntervalMs = Math.max(5_000, Number(process.env.HOST_SAMPLE_INTERVAL_MS ?? 10_000));
const historyLimit = Math.max(10, Math.min(120, Number(process.env.HOST_HISTORY_LIMIT ?? 27)));

let latest: HostMetricSnapshot | null = null;
let history: Array<Pick<HostMetricSnapshot, "collectedAt" | "cpuPercent"> & { memoryPercent: number }> = [];
let lastError = "";
let previousCpu = await readProjectCpuCounters({ procRoot, cgroupRoot, expectedParent });

async function sample(): Promise<void> {
  try {
    const result = await collectHostMetrics({
      procRoot,
      cgroupRoot,
      expectedParent,
      previousCpu,
    });
    previousCpu = result.cpu;
    latest = result.snapshot;
    history = [
      ...history,
      {
        collectedAt: latest.collectedAt,
        cpuPercent: latest.cpuPercent,
        memoryPercent: latest.memory.percent,
      },
    ].slice(-historyLimit);
    lastError = "";
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Host metrics collection failed";
  }
}

await new Promise((resolve) => setTimeout(resolve, 300));
await sample();
const sampleTimer = setInterval(() => void sample(), sampleIntervalMs);
sampleTimer.unref();

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  if (request.url === "/healthz") {
    response.writeHead(latest ? 200 : 503).end(JSON.stringify({ ok: Boolean(latest) }));
    return;
  }
  if (request.url === "/metrics") {
    if (!latest) {
      response.writeHead(503).end(JSON.stringify({ ok: false, error: lastError || "Metrics unavailable" }));
      return;
    }
    response.writeHead(200).end(JSON.stringify({ ok: true, host: latest, history }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
});

function shutdown(): void {
  clearInterval(sampleTimer);
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, "0.0.0.0");
