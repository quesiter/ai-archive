export type SystemAlert = {
  level: "warning" | "critical";
  metric: "cpu" | "memory" | "swap" | "storage";
  message: string;
};

type HostMetricInput = {
  cpuPercent: number;
  memory: { percent: number };
  swap: { totalBytes: number; percent: number };
};

function alertFor(metric: SystemAlert["metric"], label: string, percent: number): SystemAlert | null {
  if (percent >= 95) return { level: "critical", metric, message: `${label}使用率 ${percent.toFixed(1)}%` };
  if (percent >= 85) return { level: "warning", metric, message: `${label}使用率 ${percent.toFixed(1)}%` };
  return null;
}

export function systemAlerts(host: HostMetricInput): SystemAlert[] {
  return [
    alertFor("cpu", "项目 CPU", host.cpuPercent),
    alertFor("memory", "项目内存额度", host.memory.percent),
    host.swap.totalBytes > 0 ? alertFor("swap", "项目 Swap 额度", host.swap.percent) : null,
  ].filter((alert): alert is SystemAlert => Boolean(alert));
}

export function projectStorageAlert(percent: number | null): SystemAlert | null {
  return percent === null ? null : alertFor("storage", "项目存储预算", percent);
}
