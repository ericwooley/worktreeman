import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteAiCommandProcess,
  getAiCommandProcess,
  isAiCommandProcessActive,
  readAiCommandProcessLogs,
  startAiCommandProcess,
  stopAllAiCommandProcesses,
} from "./ai-command-process-service.js";

async function waitForProcessToExit(processName: string, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const processInfo = await getAiCommandProcess(processName);
    if (!processInfo || !isAiCommandProcessActive(processInfo.status)) {
      return processInfo;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for AI process ${processName} to exit.`);
}

test("AI command processes capture stdout directly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-${Date.now()}`;
  const outFile = path.join(tempDir, "stdout.log");
  const errFile = path.join(tempDir, "stderr.log");

  try {
    await startAiCommandProcess({
      processName,
      command: "printf 'hello from stdout\n'",
      worktreePath: tempDir,
      env: process.env,
      outFile,
      errFile,
    });

    const processInfo = await waitForProcessToExit(processName);
    const logs = await readAiCommandProcessLogs(processInfo);

    assert.equal(logs.stdout, "hello from stdout\n");
    assert.equal(logs.stderr, "");
    assert.equal(processInfo?.exitCode ?? 0, 0);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process logs keep stderr in log data for successful runs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-sanitize-${Date.now()}`;
  const outFile = path.join(tempDir, "stdout.log");
  const errFile = path.join(tempDir, "stderr.log");

  try {
    await startAiCommandProcess({
      processName,
      command: "printf '\\033[0mhello\\033[0m\\n' && printf '\\033[31mwarn\\033[0m\\n' >&2",
      worktreePath: tempDir,
      env: process.env,
      outFile,
      errFile,
    });

    const processInfo = await waitForProcessToExit(processName);
    const logs = await readAiCommandProcessLogs(processInfo);

    assert.equal(logs.stdout, "hello\n");
    assert.equal(logs.stderr, "warn\n");
    assert.doesNotMatch(logs.stdout, /\u001b|\[0m/);
    assert.doesNotMatch(logs.stderr, /\u001b|\[31m/);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process logs keep stderr for failed runs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-failed-stderr-${Date.now()}`;
  const outFile = path.join(tempDir, "stdout.log");
  const errFile = path.join(tempDir, "stderr.log");

  try {
    await startAiCommandProcess({
      processName,
      command: "printf 'partial\n' && printf '\\033[31mboom\\033[0m\\n' >&2 && exit 2",
      worktreePath: tempDir,
      env: process.env,
      outFile,
      errFile,
    });

    const processInfo = await waitForProcessToExit(processName);
    const logs = await readAiCommandProcessLogs(processInfo);

    assert.equal(processInfo?.exitCode, 2);
    assert.equal(logs.stdout, "partial\n");
    assert.equal(logs.stderr, "boom\n");
    assert.doesNotMatch(logs.stderr, /\u001b|\[31m/);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stopAllAiCommandProcesses terminates managed running processes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-stop-all-${Date.now()}`;
  const outFile = path.join(tempDir, "stdout.log");
  const errFile = path.join(tempDir, "stderr.log");

  try {
    await startAiCommandProcess({
      processName,
      command: "node -e \"setInterval(() => process.stdout.write('tick\\n'), 50)\"",
      worktreePath: tempDir,
      env: process.env,
      outFile,
      errFile,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const activeProcess = await getAiCommandProcess(processName);
    assert.equal(activeProcess?.status === "online" || activeProcess?.status === "launching", true);

    await stopAllAiCommandProcesses();

    const afterStop = await getAiCommandProcess(processName);
    assert.equal(afterStop, null);
  } finally {
    await stopAllAiCommandProcesses().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
