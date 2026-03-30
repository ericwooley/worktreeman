import net from "node:net";
import os from "node:os";

const tailscaleIpv4BlockList = new net.BlockList();
tailscaleIpv4BlockList.addSubnet("100.64.0.0", 10, "ipv4");

const tailscaleIpv6BlockList = new net.BlockList();
tailscaleIpv6BlockList.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const privateIpv4BlockList = new net.BlockList();
privateIpv4BlockList.addSubnet("10.0.0.0", 8, "ipv4");
privateIpv4BlockList.addSubnet("172.16.0.0", 12, "ipv4");
privateIpv4BlockList.addSubnet("192.168.0.0", 16, "ipv4");

const privateIpv6BlockList = new net.BlockList();
privateIpv6BlockList.addSubnet("fc00::", 7, "ipv6");

export interface ResolveServerHostOptions {
  requestedHost?: string;
  dangerouslyExposeToNetwork?: boolean;
  networkInterfaces?: ReturnType<typeof os.networkInterfaces>;
}

export interface ResolvedServerHost {
  listenHost: string;
  urlHost: string;
  category: "tailscale" | "wireguard" | "lan" | "loopback" | "custom" | "wildcard";
  source: "auto" | "manual";
  warning?: string;
  detail: string;
}

interface InterfaceCandidate {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  category: "tailscale" | "wireguard" | "lan";
}

export function resolveServerHost(options: ResolveServerHostOptions = {}): ResolvedServerHost {
  const requestedHost = normalizeHost(options.requestedHost);

  if (!requestedHost) {
    return {
      listenHost: "127.0.0.1",
      urlHost: "localhost",
      category: "loopback",
      source: "auto",
      detail: "default localhost",
    };
  }

  if (requestedHost === "auto") {
    return resolveAutoServerHost(options.networkInterfaces ?? os.networkInterfaces());
  }

  if (isWildcardHost(requestedHost)) {
    if (!options.dangerouslyExposeToNetwork) {
      throw new Error(
        `Refusing to bind the worktreeman server to ${requestedHost} without --dangerously-expose-to-network. `
        + "This would expose the terminal-enabled web UI to your network.",
      );
    }

    return {
      listenHost: requestedHost,
      urlHost: net.isIP(requestedHost) === 6 ? "::1" : "127.0.0.1",
      category: "wildcard",
      source: "manual",
      warning:
        `[startup] Warning: binding to ${requestedHost} exposes the worktreeman server to every reachable network interface.`,
      detail: `manual wildcard host ${requestedHost}`,
    };
  }

  return {
    listenHost: requestedHost,
    urlHost: requestedHost,
    category: isLoopbackHost(requestedHost) ? "loopback" : "custom",
    source: "manual",
    detail: `manual host ${requestedHost}`,
  };
}

export function formatServerUrl(host: string, port: number): string {
  return `http://${formatUrlHost(host)}:${port}`;
}

export function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "0.0.0.0" || isIpv6UnspecifiedHost(normalized);
}

function resolveAutoServerHost(networkInterfaces: ReturnType<typeof os.networkInterfaces>): ResolvedServerHost {
  const candidates = collectCandidates(networkInterfaces);

  if (candidates.length === 0) {
    return {
      listenHost: "127.0.0.1",
      urlHost: "localhost",
      category: "loopback",
      source: "auto",
      detail: "auto fallback to localhost",
    };
  }

  const selected = candidates.sort(compareCandidates)[0];
  return {
    listenHost: selected.address,
    urlHost: selected.address,
    category: selected.category,
    source: "auto",
    detail: `auto selected ${selected.category} interface ${selected.name} (${selected.address})`,
  };
}

function collectCandidates(networkInterfaces: ReturnType<typeof os.networkInterfaces>): InterfaceCandidate[] {
  const candidates: InterfaceCandidate[] = [];

  for (const [name, entries] of Object.entries(networkInterfaces)) {
    for (const entry of entries ?? []) {
      const family = normalizeFamily(entry.family);
      if (!family || entry.internal) {
        continue;
      }

      const address = normalizeAddress(entry.address);
      const lowerName = name.toLowerCase();

      if (isTailscaleCandidate(lowerName, address, family)) {
        candidates.push({ name, address, family, category: "tailscale" });
        continue;
      }

      if (isWireGuardCandidate(lowerName, address, family)) {
        candidates.push({ name, address, family, category: "wireguard" });
        continue;
      }

      if (isLanCandidate(address, family)) {
        candidates.push({ name, address, family, category: "lan" });
      }
    }
  }

  return candidates;
}

function compareCandidates(left: InterfaceCandidate, right: InterfaceCandidate): number {
  return categoryRank(left.category) - categoryRank(right.category)
    || familyRank(left.family) - familyRank(right.family)
    || left.name.localeCompare(right.name)
    || left.address.localeCompare(right.address);
}

function categoryRank(category: InterfaceCandidate["category"]): number {
  switch (category) {
    case "tailscale":
      return 0;
    case "wireguard":
      return 1;
    case "lan":
      return 2;
  }
}

function familyRank(family: InterfaceCandidate["family"]): number {
  return family === "IPv4" ? 0 : 1;
}

function isTailscaleCandidate(name: string, address: string, family: "IPv4" | "IPv6"): boolean {
  return name.includes("tailscale") || isTailscaleAddress(address, family);
}

function isWireGuardCandidate(name: string, address: string, family: "IPv4" | "IPv6"): boolean {
  if (name.startsWith("wg")) {
    return true;
  }

  if (!name.startsWith("utun")) {
    return false;
  }

  return isTailscaleAddress(address, family) || isLanCandidate(address, family);
}

function isLanCandidate(address: string, family: "IPv4" | "IPv6"): boolean {
  if (family === "IPv4") {
    return privateIpv4BlockList.check(address, "ipv4");
  }

  return privateIpv6BlockList.check(address, "ipv6");
}

function isTailscaleAddress(address: string, family: "IPv4" | "IPv6"): boolean {
  if (family === "IPv4") {
    return tailscaleIpv4BlockList.check(address, "ipv4");
  }

  return tailscaleIpv6BlockList.check(address, "ipv6");
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function normalizeHost(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }

  const trimmed = host.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeAddress(trimmed.toLowerCase());
  return normalized === "local" ? "localhost" : normalized;
}

function normalizeAddress(address: string): string {
  const withoutBrackets = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const zoneIndex = withoutBrackets.indexOf("%");
  return zoneIndex >= 0 ? withoutBrackets.slice(0, zoneIndex) : withoutBrackets;
}

function normalizeFamily(family: string | number): "IPv4" | "IPv6" | null {
  if (family === "IPv4" || family === 4) {
    return "IPv4";
  }

  if (family === "IPv6" || family === 6) {
    return "IPv6";
  }

  return null;
}

function formatUrlHost(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function isIpv6UnspecifiedHost(host: string | undefined): boolean {
  return typeof host === "string"
    && net.isIP(host) === 6
    && host.split(":").join("").split("0").join("") === "";
}
