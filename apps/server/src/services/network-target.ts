import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { config } from "../config.js";

export interface ResolvedNetworkHost {
  hostname: string;
  addresses: LookupAddress[];
}

export function isPrivateNetworkAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address.split("%")[0] ?? "");
    const normalized =
      parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
        ? parsed.toIPv4Address()
        : parsed;
    return normalized.range() !== "unicast";
  } catch {
    return true;
  }
}

export function validateNetworkUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP(S) network targets are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Network target URLs must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Network target URLs must not contain query parameters or fragments");
  }
  return url;
}

export async function resolveSafeNetworkHost(
  hostname: string,
): Promise<ResolvedNetworkHost> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !config.ALLOW_PRIVATE_NETWORK_TARGETS &&
    (normalized === "localhost" || normalized.endsWith(".localhost"))
  ) {
    throw new Error("Private or loopback network targets are not allowed");
  }
  const literalVersion = isIP(normalized);
  const addresses = literalVersion
    ? [{ address: normalized, family: literalVersion }]
    : await lookup(normalized, { all: true, verbatim: true });
  if (
    !addresses.length ||
    (!config.ALLOW_PRIVATE_NETWORK_TARGETS &&
      addresses.some((entry) => isPrivateNetworkAddress(entry.address)))
  ) {
    throw new Error("Private, loopback, link-local, and reserved network targets are not allowed");
  }
  return { hostname: normalized, addresses };
}

export async function assertSafeNetworkHost(hostname: string): Promise<void> {
  await resolveSafeNetworkHost(hostname);
}

export async function assertSafeNetworkUrl(value: string): Promise<URL> {
  const url = validateNetworkUrl(value);
  await assertSafeNetworkHost(url.hostname);
  return url;
}

function lookupError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Network target hostname changed: ${hostname}`), {
    code: "ENOTFOUND",
    hostname,
  });
}

/**
 * Returns a DNS callback that only serves the addresses checked above. This
 * keeps validation and the actual socket connection on the same DNS result and
 * closes the DNS-rebinding gap between those two operations.
 */
export function pinnedLookup(resolved: ResolvedNetworkHost) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized !== resolved.hostname) {
      callback(lookupError(hostname), "", 0);
      return;
    }
    const requestedFamily =
      options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const candidates = requestedFamily
      ? resolved.addresses.filter((entry) => entry.family === requestedFamily)
      : resolved.addresses;
    if (!candidates.length) {
      callback(lookupError(hostname), "", 0);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0]!;
    callback(null, selected.address, selected.family);
  };
}

export async function createPinnedNetworkDispatcher(value: string): Promise<Agent> {
  const url = validateNetworkUrl(value);
  const resolved = await resolveSafeNetworkHost(url.hostname);
  return new Agent({ connect: { lookup: pinnedLookup(resolved) } });
}

export async function withPinnedNetworkDispatcher<T>(
  value: string,
  operation: (dispatcher: Agent) => Promise<T>,
): Promise<T> {
  const dispatcher = await createPinnedNetworkDispatcher(value);
  try {
    return await operation(dispatcher);
  } finally {
    await dispatcher.close();
  }
}
