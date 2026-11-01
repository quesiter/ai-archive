type ProjectActivity = {
  growth7d?: unknown;
  latestActivityAt?: unknown;
  projectName?: string;
};

function activityTime(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

export function recentActiveProjects<T extends ProjectActivity>(projects: readonly T[]): T[] {
  return projects.filter(project => Number(project.growth7d) > 0).sort((left, right) =>
    activityTime(right.latestActivityAt) - activityTime(left.latestActivityAt) ||
    Number(right.growth7d) - Number(left.growth7d) ||
    (left.projectName ?? "").localeCompare(right.projectName ?? ""));
}
