import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "./app.js";
import { initRepository } from "./services/init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "./services/repository-layout-service.js";
import { findRepoContext } from "./utils/paths.js";

async function createTestRepo() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-app-"));

  await createBareRepoLayout({ rootDir });
  await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
  await initRepository(rootDir, { runtimePorts: ["PORT"], force: false });

  return {
    rootDir,
    repo: await findRepoContext(rootDir),
  };
}

async function listenOnEphemeralPort() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("occupied");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve occupied port.");
  }

  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("startServer falls back to another available port when the default port is occupied", async () => {
  const previousPort = process.env.PORT;
  const { rootDir, repo } = await createTestRepo();
  const occupiedServer = await listenOnEphemeralPort();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    process.env.PORT = String(occupiedServer.port);
    startedServer = await startServer({ repo, openBrowser: false });

    assert.notEqual(startedServer.port, occupiedServer.port);
    assert.ok(startedServer.port > 0);
  } finally {
    process.env.PORT = previousPort;

    await startedServer?.close();
    await occupiedServer.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer still fails when an explicitly requested port is occupied", async () => {
  const { rootDir, repo } = await createTestRepo();
  const occupiedServer = await listenOnEphemeralPort();

  try {
    await assert.rejects(
      () => startServer({ repo, port: occupiedServer.port, openBrowser: false }),
      /already in use/,
    );
  } finally {
    await occupiedServer.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
