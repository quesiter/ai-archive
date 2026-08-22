export type SystemAlert = {
  level: "warning" | "critical";
  metric: "cpu" | "memory" | "swap" | "disk" | "inode";
  message: string;
};

type HostMetricInput = {
  cpuPercent: number;
  memory: { percent: number };
  swap: { totalBytes: number; percent: number };
  storage: { percent: number; inodePercent: number };
};

function alertFor(metric: SystemAlert["metric"], label: string, percent: number): SystemAlert | null {
  if (percent >= 95) return { level: "critical", metric, message: `${label}使用率 ${percent.toFixed(1)}%` };
  if (percent >= 85) return { level: "warning", metric, message: `${label}使用率 ${percent.toFixed(1)}%` };
  return null;
}

export function systemAlerts(host: HostMetricInput): SystemAlert[] {
  return [
    alertFor("cpu", "CPU", host.cpuPercent),
    alertFor("memory", "内存", host.memory.percent),
    host.swap.totalBytes > 0 ? alertFor("swap", "Swap", host.swap.percent) : null,
    alertFor("disk", "磁盘", host.storage.percent),
    alertFor("inode", "inode", host.storage.inodePercent),
  ].filter((alert): alert is SystemAlert => Boolean(alert));
}
