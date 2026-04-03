import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "#test-runtime";
import pm2 from "pm2";
import type { ProcessDescription, StartOptions } from "pm2";
import { startBackgroundCommand, stopAllBackgroundCommands } from "./background-command-service.js";
import { stopOperationalStateStore } from "./operational-state-service.js";
import type { WorktreeManagerConfig, WorktreeRecord, WorktreeRuntime } from "../../shared/types.js";
import { worktreeId } from "../../shared/worktree-id.js";

async function withPm2<T>(operation: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    pm2.connect((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  try {
    return await operation();
  } finally {
    const disconnectPm2 = pm2.disconnect.bind(pm2) as unknown as (callback?: () => void) => void;
    await new Promise<void>((resolve) => {
      disconnectPm2(() => resolve());
    });
  }
}

async function startPm2Process(options: StartOptions): Promise<void> {
  await withPm2(() => new Promise<void>((resolve, reject) => {
    pm2.start(options, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));
}

async function deletePm2Process(processName: string): Promise<void> {
  await withPm2(() => new Promise<void>((resolve, reject) => {
    pm2.delete(processName, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));
}

async function listPm2ProcessNames(): Promise<string[]> {
  return await withPm2(() => new Promise<string[]>((resolve, reject) => {
    pm2.list((error, processes) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(
        processes
          .map((entry: ProcessDescription) => entry.name)
          .filter((name): name is string => typeof name === "string"),
      );
    });
  }));
}

async function getPm2Process(processName: string): Promise<ProcessDescription | null> {
  return await withPm2(() => new Promise<ProcessDescription | null>((resolve, reject) => {
    pm2.list((error, processes) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(processes.find((entry) => entry.name === processName) ?? null);
    });
  }));
}

async function waitForProcessPresence(processName: string, expected: boolean, timeoutMs = 20000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const names = await listPm2ProcessNames();
    if (names.includes(processName) === expected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for PM2 process ${processName} presence=${String(expected)}.`);
}

function createConfig(commandName: string, command: string): WorktreeManagerConfig {
  return {
    favicon: "⚡",
    env: {},
    runtimePorts: [],
    derivedEnv: {},
    quickLinks: [],
    aiCommands: {
      smart: "printf %s $WTM_AI_INPUT",
      simple: "printf %s $WTM_AI_INPUT",
      autoStartRuntime: false,
    },
    startupCommands: [],
    backgroundCommands: {
      [commandName]: { command },
    },
    projectManagement: {
      users: {
        customUsers: [],
        archivedUserIds: [],
      },
    },
    worktrees: { baseDir: "." },
  };
}

function createRuntime(branch: string, worktreePath: string): WorktreeRuntime {
  const id = worktreeId(worktreePath);
  return {
    id,
    branch,
    worktreePath,
    env: {},
    quickLinks: [],
    allocatedPorts: {},
    tmuxSession: `wtm-test-${branch}`,
    runtimeStartedAt: new Date().toISOString(),
  };
}

function createWorktree(branch: string, worktreePath: string): Pick<WorktreeRecord, "id" | "branch" | "worktreePath"> {
  return {
    id: worktreeId(worktreePath),
    branch,
    worktreePath,
  };
}

test("stopAllBackgroundCommands removes managed background commands for the matching worktree", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-background-managed-"));
  const branch = `feature-managed-${Date.now()}`;
  const commandName = "worker";
  const worktree = createWorktree(branch, tempDir);
  const processName = `wtm:${worktree.id}:${commandName}`;

  try {
    await startBackgroundCommand({
      config: createConfig(commandName, `${process.execPath} -e \"setInterval(() => {}, 1000)\"`),
      repoRoot: tempDir,
      worktree,
      runtime: createRuntime(branch, tempDir),
      commandName,
    });

    await waitForProcessPresence(processName, true);

    await stopAllBackgroundCommands(tempDir, worktree);

    await waitForProcessPresence(processName, false);
  } finally {
    await deletePm2Process(processName).catch(() => undefined);
    await stopOperationalStateStore(tempDir).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startBackgroundCommand assigns a branch-specific PM2 namespace", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-background-namespace-"));
  const branch = `feature-namespace-${Date.now()}`;
  const commandName = "worker";
  const worktree = createWorktree(branch, tempDir);
  const processName = `wtm:${worktree.id}:${commandName}`;

  try {
    await startBackgroundCommand({
      config: createConfig(commandName, `${process.execPath} -e "setInterval(() => {}, 1000)"`),
      repoRoot: tempDir,
      worktree,
      runtime: createRuntime(branch, tempDir),
      commandName,
    });

    await waitForProcessPresence(processName, true);

    const processDescription = await getPm2Process(processName);
    assert.equal((processDescription?.pm2_env as { namespace?: string } | undefined)?.namespace, `worktreeman:${worktree.id}`);
  } finally {
    await deletePm2Process(processName).catch(() => undefined);
    await stopOperationalStateStore(tempDir).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stopAllBackgroundCommands ignores unrelated PM2 processes that only share the branch prefix", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-background-unrelated-"));
  const branch = `feature-unrelated-${Date.now()}`;
  const worktree = createWorktree(branch, tempDir);
  const processName = `wtm:${worktree.id}:dev`;

  try {
    await startPm2Process({
      name: processName,
      script: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      interpreter: "none",
      cwd: tempDir,
    });

    await waitForProcessPresence(processName, true);

    await stopAllBackgroundCommands(tempDir, worktree);

    await waitForProcessPresence(processName, true);
  } finally {
    await deletePm2Process(processName).catch(() => undefined);
    await stopOperationalStateStore(tempDir).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
