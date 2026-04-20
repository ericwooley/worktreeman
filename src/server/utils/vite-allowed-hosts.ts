import os from "node:os";

function addHost(target: Set<string>, host: string | null | undefined) {
  const normalized = host?.trim();
  if (!normalized) {
    return;
  }

  target.add(normalized);
}

export function getViteAllowedHosts(extraHosts: Array<string | null | undefined> = []): string[] {
  const hosts = new Set<string>();
  const machineHost = os.hostname();

  addHost(hosts, "localhost");
  addHost(hosts, "127.0.0.1");
  addHost(hosts, "::1");
  addHost(hosts, machineHost);
  addHost(hosts, machineHost.split(".")[0]);

  for (const host of extraHosts) {
    addHost(hosts, host);
  }

  return Array.from(hosts);
}
