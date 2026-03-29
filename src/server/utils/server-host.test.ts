import assert from "node:assert/strict";
import test from "node:test";
import { formatServerUrl, isWildcardHost, resolveServerHost } from "./server-host.js";

test("resolveServerHost auto prefers Tailscale over WireGuard, LAN, and localhost", () => {
  const resolved = resolveServerHost({
    requestedHost: "auto",
    networkInterfaces: {
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, mac: "", netmask: "255.255.255.0", cidr: "192.168.1.20/24" }],
      wg0: [{ address: "10.10.0.2", family: "IPv4", internal: false, mac: "", netmask: "255.255.255.0", cidr: "10.10.0.2/24" }],
      tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false, mac: "", netmask: "255.192.0.0", cidr: "100.101.102.103/10" }],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", netmask: "255.0.0.0", cidr: "127.0.0.1/8" }],
    },
  });

  assert.equal(resolved.listenHost, "100.101.102.103");
  assert.equal(resolved.category, "tailscale");
  assert.equal(resolved.source, "auto");
});

test("resolveServerHost defaults to localhost when no host is requested", () => {
  const resolved = resolveServerHost();

  assert.equal(resolved.listenHost, "127.0.0.1");
  assert.equal(resolved.urlHost, "localhost");
  assert.equal(resolved.category, "loopback");
  assert.equal(resolved.source, "auto");
  assert.equal(resolved.detail, "default localhost");
});

test("resolveServerHost treats local as localhost", () => {
  const resolved = resolveServerHost({ requestedHost: "local" });

  assert.equal(resolved.listenHost, "localhost");
  assert.equal(resolved.urlHost, "localhost");
  assert.equal(resolved.category, "loopback");
  assert.equal(resolved.source, "manual");
  assert.equal(resolved.detail, "manual host localhost");
});

test("resolveServerHost auto prefers WireGuard over LAN when Tailscale is unavailable", () => {
  const resolved = resolveServerHost({
    requestedHost: "auto",
    networkInterfaces: {
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, mac: "", netmask: "255.255.255.0", cidr: "192.168.1.20/24" }],
      wg0: [{ address: "10.10.0.2", family: "IPv4", internal: false, mac: "", netmask: "255.255.255.0", cidr: "10.10.0.2/24" }],
    },
  });

  assert.equal(resolved.listenHost, "10.10.0.2");
  assert.equal(resolved.category, "wireguard");
});

test("resolveServerHost auto falls back to localhost when no external private interface exists", () => {
  const resolved = resolveServerHost({
    requestedHost: "auto",
    networkInterfaces: {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", netmask: "255.0.0.0", cidr: "127.0.0.1/8" }],
    },
  });

  assert.equal(resolved.listenHost, "127.0.0.1");
  assert.equal(resolved.urlHost, "localhost");
  assert.equal(resolved.category, "loopback");
});

test("resolveServerHost rejects wildcard hosts without dangerous exposure flag", () => {
  assert.throws(
    () => resolveServerHost({ requestedHost: "0.0.0.0" }),
    /dangerously-expose-to-network/,
  );
  assert.throws(
    () => resolveServerHost({ requestedHost: "::" }),
    /dangerously-expose-to-network/,
  );
});

test("resolveServerHost allows wildcard hosts with dangerous exposure flag and warns", () => {
  const ipv4 = resolveServerHost({ requestedHost: "0.0.0.0", dangerouslyExposeToNetwork: true });
  const ipv6 = resolveServerHost({ requestedHost: "::", dangerouslyExposeToNetwork: true });

  assert.equal(ipv4.listenHost, "0.0.0.0");
  assert.equal(ipv4.urlHost, "127.0.0.1");
  assert.match(ipv4.warning ?? "", /exposes the worktreeman server/);
  assert.equal(ipv6.listenHost, "::");
  assert.equal(ipv6.urlHost, "::1");
});

test("isWildcardHost recognizes IPv4 and IPv6 unspecified addresses", () => {
  assert.equal(isWildcardHost("0.0.0.0"), true);
  assert.equal(isWildcardHost("::"), true);
  assert.equal(isWildcardHost("0:0:0:0:0:0:0:0"), true);
  assert.equal(isWildcardHost("127.0.0.1"), false);
});

test("formatServerUrl brackets IPv6 hosts", () => {
  assert.equal(formatServerUrl("127.0.0.1", 4312), "http://127.0.0.1:4312");
  assert.equal(formatServerUrl("::1", 4312), "http://[::1]:4312");
});
