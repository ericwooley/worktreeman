import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "./app.js";
import { initRepository } from "./services/init-service.js";
import { createOperationalStateStore, stopOperationalStateStore } from "./services/operational-state-service.js";
import { getAiCommandProcess, getAiCommandProcessName, startAiCommandProcess } from "./services/ai-command-process-service.js";
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
    startedServer = await startServer({ repo, host: "127.0.0.1", openBrowser: false });

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
      () => startServer({ repo, host: "127.0.0.1", port: occupiedServer.port, openBrowser: false }),
      /already in use/,
    );
  } finally {
    await occupiedServer.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer defaults to localhost URLs when no host is requested", async () => {
  const { rootDir, repo } = await createTestRepo();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    startedServer = await startServer({
      repo,
      port: await listenFreePort(),
      openBrowser: false,
    });

    assert.equal(startedServer.host, "127.0.0.1");
    assert.equal(startedServer.url, `http://localhost:${startedServer.port}`);
  } finally {
    await startedServer?.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer returns localhost URL details for auto fallback", async () => {
  const { rootDir, repo } = await createTestRepo();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    startedServer = await startServer({
      repo,
      host: "auto",
      port: await listenFreePort(),
      openBrowser: false,
      networkInterfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", netmask: "255.0.0.0", cidr: "127.0.0.1/8" }],
      },
    });

    assert.equal(startedServer.host, "127.0.0.1");
    assert.equal(startedServer.url, `http://localhost:${startedServer.port}`);
  } finally {
    await startedServer?.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer treats local host alias as localhost", async () => {
  const { rootDir, repo } = await createTestRepo();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    startedServer = await startServer({
      repo,
      host: "local",
      port: await listenFreePort(),
      openBrowser: false,
    });

    assert.equal(startedServer.host, "localhost");
    assert.equal(startedServer.url, `http://localhost:${startedServer.port}`);
  } finally {
    await startedServer?.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer rejects wildcard host binding without explicit dangerous exposure flag", async () => {
  const { rootDir, repo } = await createTestRepo();

  try {
    await assert.rejects(
      () => startServer({ repo, host: "0.0.0.0", openBrowser: false }),
      /dangerously-expose-to-network/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer allows wildcard host binding when dangerous exposure flag is set", async () => {
  const { rootDir, repo } = await createTestRepo();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    startedServer = await startServer({
      repo,
      host: "0.0.0.0",
      dangerouslyExposeToNetwork: true,
      port: await listenFreePort(),
      openBrowser: false,
    });

    assert.equal(startedServer.host, "0.0.0.0");
    assert.equal(startedServer.url, `http://127.0.0.1:${startedServer.port}`);
  } finally {
    await startedServer?.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer uses config preferredPort and falls back when it is occupied", async () => {
  const previousPort = process.env.PORT;
  const { rootDir, repo } = await createTestRepo();
  const occupiedServer = await listenOnEphemeralPort();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    process.env.PORT = "";
    const contents = await fs.readFile(repo.configPath, "utf8");
    await fs.writeFile(
      repo.configPath,
      contents.replace("preferredPort: 4312", `preferredPort: ${occupiedServer.port}`),
      "utf8",
    );

    startedServer = await startServer({ repo, host: "127.0.0.1", openBrowser: false });

    assert.notEqual(startedServer.port, occupiedServer.port);
    assert.ok(startedServer.port > 0);
  } finally {
    process.env.PORT = previousPort;

    await startedServer?.close();
    await occupiedServer.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer serves favicon from configured repository file", async () => {
  const { rootDir, repo } = await createTestRepo();
  const faviconDir = path.join(repo.configWorktreePath, "assets");
  const faviconPath = path.join(faviconDir, "favicon.png");
  const faviconBytes = crypto.randomBytes(16);
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    await fs.mkdir(faviconDir, { recursive: true });
    await fs.writeFile(faviconPath, faviconBytes);

    const contents = await fs.readFile(repo.configPath, "utf8");
    await fs.writeFile(
      repo.configPath,
      contents.replace("favicon: ''", "favicon: assets/favicon.png"),
      "utf8",
    );

    startedServer = await startServer({ repo, host: "127.0.0.1", port: await listenFreePort(), openBrowser: false });
    const response = await fetch(`${startedServer.url}/favicon.ico`);
    const responseBytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.deepEqual(responseBytes, faviconBytes);
  } finally {
    await startedServer?.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer clears persisted shutdown status from a previous server run", async () => {
  const { rootDir, repo } = await createTestRepo();
  const operationalState = await createOperationalStateStore(repo.repoRoot);
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    await operationalState.beginShutdown("[shutdown] Closing worktreeman server...");
    await operationalState.completeShutdown("[shutdown] Shutdown complete.");
    await stopOperationalStateStore(repo.repoRoot);

    startedServer = await startServer({ repo, host: "127.0.0.1", port: await listenFreePort(), openBrowser: false });

    const restartedOperationalState = await createOperationalStateStore(repo.repoRoot);
    const status = await restartedOperationalState.getShutdownStatus();

    assert.deepEqual(status, {
      active: false,
      completed: false,
      failed: false,
      logs: [],
    });
  } finally {
    await startedServer?.close();
    await stopOperationalStateStore(repo.repoRoot);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer reconciles interrupted running AI jobs on startup", async () => {
  const { rootDir, repo } = await createTestRepo();
  const operationalState = await createOperationalStateStore(repo.repoRoot);
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    await operationalState.setAiCommandJob({
      jobId: "interrupted-job",
      fileName: "interrupted-job.json",
      branch: "main",
      commandId: "smart",
      command: "printf %s 'resume'",
      input: "resume",
      status: "running",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      stdout: "partial output",
      stderr: "",
      outputEvents: [],
      pid: 9999,
      exitCode: null,
      processName: "wtm:ai:missing-restart-process",
    });
    await stopOperationalStateStore(repo.repoRoot);

    startedServer = await startServer({ repo, host: "127.0.0.1", port: await listenFreePort(), openBrowser: false });

    const restartedOperationalState = await createOperationalStateStore(repo.repoRoot);
    const reconciledJob = await restartedOperationalState.getAiCommandJob("main");
    assert.equal(reconciledJob?.status, "failed");
    assert.match(reconciledJob?.error ?? "", /no longer available/);
    assert.equal(reconciledJob?.stdout, "partial output");
    assert.equal(typeof reconciledJob?.completedAt, "string");
  } finally {
    await startedServer?.close();
    await stopOperationalStateStore(repo.repoRoot);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("startServer closes managed AI command processes during shutdown", async () => {
  const { rootDir, repo } = await createTestRepo();
  let startedServer: Awaited<ReturnType<typeof startServer>> | undefined;
  const processName = getAiCommandProcessName(`shutdown-${Date.now()}`);

  try {
    await startAiCommandProcess({
      processName,
      command: "node -e \"setInterval(() => {}, 1000)\"",
      input: "",
      worktreePath: path.join(repo.repoRoot, "main"),
      env: process.env,
    });

    startedServer = await startServer({ repo, host: "127.0.0.1", port: await listenFreePort(), openBrowser: false });
    await startedServer.close();
    startedServer = undefined;

    const processInfo = await getAiCommandProcess(processName);
    assert.equal(processInfo, null);
  } finally {
    await startedServer?.close();
    await stopOperationalStateStore(repo.repoRoot);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

async function listenFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate free port.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return address.port;
}
