export function latestAdaptersByProvider<T extends Record<string, unknown>>(adapters: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const adapter of adapters) {
    const provider = String(adapter.provider);
    const current = latest.get(provider);
    if (!current || String(adapter.adapterVersion ?? "").localeCompare(String(current.adapterVersion ?? ""), "en", { numeric: true }) > 0) {
      latest.set(provider, adapter);
    }
  }
  return [...latest.values()];
}
