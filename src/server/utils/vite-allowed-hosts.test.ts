import assert from "node:assert/strict";
import os from "node:os";
import test from "#test-runtime";
import { getViteAllowedHosts } from "./vite-allowed-hosts.js";

test("getViteAllowedHosts includes localhost and machine host aliases without duplicates", () => {
  const machineHost = os.hostname();
  const shortMachineHost = machineHost.split(".")[0] ?? machineHost;
  const hosts = getViteAllowedHosts([machineHost, "dev-box", "dev-box"]);

  assert.ok(hosts.includes("localhost"));
  assert.ok(hosts.includes("127.0.0.1"));
  assert.ok(hosts.includes("::1"));
  assert.ok(hosts.includes(machineHost));
  assert.ok(hosts.includes(shortMachineHost));
  assert.ok(hosts.includes("dev-box"));
  assert.equal(hosts.filter((host) => host === "dev-box").length, 1);
});
