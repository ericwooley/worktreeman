import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "#test-runtime";
import {
  deleteAiCommandProcess,
  getAiCommandProcess,
  isAiCommandProcessActive,
  startAiCommandProcess,
  stopAllAiCommandProcesses,
  waitForAiCommandProcess,
} from "./ai-command-process-service.js";
import { getAiDiagnosticsThresholdsForTest, resetAiDiagnosticsForTest } from "./ai-command-diagnostics-service.js";

function createLineCollector(target: string[]) {
  return (chunk: string | Uint8Array) => {
    target.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
}

async function runManagedProcess(options: {
  processName: string;
  command: string;
  input: string;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  await startAiCommandProcess({
    ...options,
    hooks: {
      onStdout: (chunk) => {
        stdout.push(chunk);
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
    },
  });

  const processInfo = await waitForAiCommandProcess(options.processName);
  return {
    processInfo,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

test("AI command processes capture stdout directly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-${Date.now()}`;

  try {
    const result = await runManagedProcess({
      processName,
      command: "printf 'hello from stdout\n'",
      input: "",
      worktreePath: tempDir,
      env: process.env,
    });

    assert.equal(result.stdout, "hello from stdout\n");
    assert.equal(result.stderr, "");
    assert.equal(result.processInfo?.exitCode ?? 0, 0);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process logs keep stderr in log data for successful runs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-sanitize-${Date.now()}`;

  try {
    const result = await runManagedProcess({
      processName,
      command: "printf '\\033[0mhello\\033[0m\\n' && printf '\\033[31mwarn\\033[0m\\n' >&2",
      input: "",
      worktreePath: tempDir,
      env: process.env,
    });

    assert.equal(result.stdout, "hello\n");
    assert.equal(result.stderr, "warn\n");
    assert.doesNotMatch(result.stdout, /\u001b|\[0m/);
    assert.doesNotMatch(result.stderr, /\u001b|\[31m/);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process logs keep stderr for failed runs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-failed-stderr-${Date.now()}`;

  try {
    const result = await runManagedProcess({
      processName,
      command: "printf 'partial\n' && printf '\\033[31mboom\\033[0m\\n' >&2 && exit 2",
      input: "",
      worktreePath: tempDir,
      env: process.env,
    });

    assert.equal(result.processInfo?.exitCode, 2);
    assert.equal(result.stdout, "partial\n");
    assert.equal(result.stderr, "boom\n");
    assert.doesNotMatch(result.stderr, /\u001b|\[31m/);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process sets WTM_AI_INPUT env variable from input option", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-wtm-ai-input-${Date.now()}`;
  const testInput = "Hello, world! This is a test with 'single quotes' and \"double quotes\" and newlines\n";

  try {
    const result = await runManagedProcess({
      processName,
      command: "printf '%s' \"$WTM_AI_INPUT\"",
      input: testInput,
      worktreePath: tempDir,
      env: process.env,
    });

    assert.equal(result.stdout, testInput);
    assert.equal(result.processInfo?.exitCode ?? 0, 0);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AI command process passes multiline input with special chars via WTM_AI_INPUT", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-wtm-multiline-${Date.now()}`;
  const testInput = "Line one\nLine two with $special chars\nLine three with `backticks`\n";

  try {
    const result = await runManagedProcess({
      processName,
      command: "printf '%s' \"$WTM_AI_INPUT\"",
      input: testInput,
      worktreePath: tempDir,
      env: process.env,
    });

    assert.equal(result.stdout, testInput);
    assert.equal(result.processInfo?.exitCode ?? 0, 0);
  } finally {
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stopAllAiCommandProcesses terminates managed running processes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-stop-all-${Date.now()}`;

  try {
    await startAiCommandProcess({
      processName,
      command: "node -e \"setInterval(() => process.stdout.write('tick\\n'), 50)\"",
      input: "",
      worktreePath: tempDir,
      env: process.env,
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

test("AI command process diagnostics log when retained output gets large", async () => {
  resetAiDiagnosticsForTest();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-process-"));
  const processName = `wtm:ai:test-large-output-${Date.now()}`;
  const stdoutLines: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = createLineCollector(stdoutLines) as typeof process.stdout.write;
  const warnBytes = getAiDiagnosticsThresholdsForTest().processOutputWarnBytes;
  const largeChunk = "x".repeat(warnBytes + 1024);

  try {
    const stdoutChunks: string[] = [];
    await startAiCommandProcess({
      processName,
      command: `node -e "process.stdout.write('x'.repeat(${largeChunk.length}))"`,
      input: "",
      worktreePath: tempDir,
      env: process.env,
      hooks: {
        onStdout: (chunk) => {
          stdoutChunks.push(chunk);
        },
      },
    });

    await waitForAiCommandProcess(processName);

    const output = stdoutLines.join("");
    assert.equal(stdoutChunks.join(""), largeChunk);
    assert.equal(output.includes("[ai-command-diagnostics] process-output-retained"), false);
  } finally {
    process.stdout.write = originalStdoutWrite;
    resetAiDiagnosticsForTest();
    await deleteAiCommandProcess(processName).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
