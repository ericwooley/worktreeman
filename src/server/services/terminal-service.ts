import os from "node:os";
import process from "node:process";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import pty from "node-pty";
import type { TerminalClientMessage, TerminalServerMessage, TmuxClientInfo, WorktreeRuntime } from "../../shared/types.js";
import { runCommand } from "../utils/process.js";
import { sanitizeBranchName } from "../utils/paths.js";

interface TerminalServiceOptions {
  server: HttpServer;
  getRuntime(branch: string): WorktreeRuntime | undefined;
}

function send(socket: WebSocket, message: TerminalServerMessage): void {
  socket.send(JSON.stringify(message));
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildInteractiveShellCommand(shell: string): string {
  return `exec ${quoteShellArg(shell)} -l`;
}

async function hasTmuxSession(session: string, cwd: string): Promise<boolean> {
  try {
    await runCommand("tmux", ["has-session", "-t", session], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function setTmuxSessionEnvironment(runtime: WorktreeRuntime): Promise<void> {
  const sessionEnv = {
    ...runtime.env,
    WORKTREE_BRANCH: runtime.branch,
    WORKTREE_PATH: runtime.worktreePath,
    TMUX_SESSION_NAME: runtime.tmuxSession,
  };

  for (const [key, value] of Object.entries(sessionEnv)) {
    await runCommand("tmux", ["set-environment", "-t", runtime.tmuxSession, key, value], {
      cwd: runtime.worktreePath,
    });
  }
}

async function ensureTmuxSession(runtime: WorktreeRuntime, shell: string): Promise<void> {
  const sessionExists = await hasTmuxSession(runtime.tmuxSession, runtime.worktreePath);

  if (!sessionExists) {
    await runCommand(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        runtime.tmuxSession,
        "-c",
        runtime.worktreePath,
        buildInteractiveShellCommand(shell),
      ],
      { cwd: runtime.worktreePath },
    );
  }

  await setTmuxSessionEnvironment(runtime);
  await runCommand("tmux", ["set-window-option", "-g", "-t", runtime.tmuxSession, "aggressive-resize", "on"], {
    cwd: runtime.worktreePath,
  });
  await runCommand("tmux", ["set-window-option", "-t", `${runtime.tmuxSession}:0`, "aggressive-resize", "on"], {
    cwd: runtime.worktreePath,
  });

  if (!sessionExists) {
    await runCommand(
      "tmux",
      [
        "respawn-pane",
        "-k",
        "-t",
        `${runtime.tmuxSession}:0.0`,
        "-c",
        runtime.worktreePath,
        buildInteractiveShellCommand(shell),
      ],
      { cwd: runtime.worktreePath },
    );
  }
}

export async function ensureRuntimeTerminalSession(runtime: WorktreeRuntime): Promise<void> {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
  await ensureTmuxSession(runtime, shell);
}

export function getTmuxSessionName(branch: string): string {
  return `wt-${sanitizeBranchName(branch)}`;
}

function parseTmuxTimestamp(value: string): string | undefined {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }

  return new Date(timestamp * 1000).toISOString();
}

function normalizeTty(value: string): string {
  return value.trim().replace(/^\/dev\//, "");
}

async function getProcessTty(pid: number, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand("ps", ["-o", "tty=", "-p", String(pid)], { cwd });
    const tty = normalizeTty(stdout);
    return tty || null;
  } catch {
    return null;
  }
}

export async function listTmuxClients(runtime: WorktreeRuntime): Promise<TmuxClientInfo[]> {
  if (!(await hasTmuxSession(runtime.tmuxSession, runtime.worktreePath))) {
    return [];
  }

  const { stdout } = await runCommand(
    "tmux",
    [
      "list-clients",
      "-t",
      runtime.tmuxSession,
      "-F",
      "#{client_tty}\t#{client_pid}\t#{client_name}\t#{session_name}\t#{client_created}\t#{client_activity}\t#{client_control_mode}",
    ],
    { cwd: runtime.worktreePath },
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tty, pid, name, sessionName, createdAt, lastActiveAt, controlMode] = line.split("\t");
      return {
        id: tty,
        tty,
        pid: Number(pid),
        name,
        sessionName,
        createdAt: parseTmuxTimestamp(createdAt),
        lastActiveAt: parseTmuxTimestamp(lastActiveAt),
        isControlMode: controlMode === "1",
      } satisfies TmuxClientInfo;
    });
}

export async function disconnectTmuxClient(runtime: WorktreeRuntime, clientId: string): Promise<void> {
  await runCommand("tmux", ["detach-client", "-t", clientId], {
    cwd: runtime.worktreePath,
  });
}

export async function killTmuxSession(runtime: WorktreeRuntime): Promise<void> {
  await killTmuxSessionByName(runtime.tmuxSession, runtime.worktreePath);
}

export async function killTmuxSessionByName(sessionName: string, cwd: string): Promise<void> {
  if (!(await hasTmuxSession(sessionName, cwd))) {
    return;
  }

  await runCommand("tmux", ["kill-session", "-t", sessionName], {
    cwd,
  });
}

export function createTerminalService(options: TerminalServiceOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const activeTerms = new Set<pty.IPty>();

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", "http://localhost");

    if (url.pathname !== "/ws/terminal") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (upgradedSocket) => {
      wss.emit("connection", upgradedSocket, request);
    });
  };

  options.server.on("upgrade", handleUpgrade);

  wss.on("close", () => {
    options.server.off("upgrade", handleUpgrade);

    for (const term of activeTerms) {
      term.kill();
    }

    activeTerms.clear();
  });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const branch = url.searchParams.get("branch");

    if (!branch) {
      send(socket, { type: "error", message: "Missing branch query parameter." });
      socket.close();
      return;
    }

    const runtime = options.getRuntime(branch);
    if (!runtime) {
      send(socket, { type: "error", message: `No active runtime for branch ${branch}. Start the environment first.` });
      socket.close();
      return;
    }

    // Inject the host env, root config env, and dynamic Docker-derived env directly
    // into the pty process so the tmux session inherits everything in memory.
    const env = {
      ...process.env,
      ...runtime.env,
      WORKTREE_BRANCH: runtime.branch,
      WORKTREE_PATH: runtime.worktreePath,
      TMUX_SESSION_NAME: runtime.tmuxSession,
    };

    try {
      await ensureRuntimeTerminalSession(runtime);
    } catch (error) {
      send(socket, {
        type: "error",
        message: error instanceof Error ? error.message : "Failed to prepare tmux session.",
      });
      socket.close();
      return;
    }

    const term = pty.spawn("tmux", ["attach-session", "-t", runtime.tmuxSession], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: runtime.worktreePath,
      env,
    });
    activeTerms.add(term);

    const resolveCurrentClientId = async () => {
      try {
        const clients = await listTmuxClients(runtime);
        const processTty = await getProcessTty(term.pid, runtime.worktreePath);
        const matchedClient = clients.find((client) => {
          if (processTty && normalizeTty(client.tty) === processTty) {
            return true;
          }

          return client.pid === term.pid;
        });

        if (!matchedClient) {
          send(socket, { type: "ready", session: runtime.tmuxSession, clientId: null });
          return;
        }

        send(socket, { type: "ready", session: runtime.tmuxSession, clientId: matchedClient.id });
      } catch {
        send(socket, { type: "ready", session: runtime.tmuxSession, clientId: null });
      }
    };

    void resolveCurrentClientId();

    term.onData((data) => {
      send(socket, { type: "output", data });
    });

    term.onExit(({ exitCode }) => {
      activeTerms.delete(term);
      send(socket, { type: "exit", exitCode });
      socket.close();
    });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as TerminalClientMessage;
        if (message.type === "input") {
          term.write(message.data);
        } else if (message.type === "resize") {
          term.resize(message.cols, message.rows);
        }
      } catch (error) {
        send(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid terminal payload." });
      }
    });

    socket.on("close", () => {
      activeTerms.delete(term);
      term.kill();
    });
  });

  return wss;
}

export function defaultTerminalInfo(): { shell: string; platform: string; home: string } {
  return {
    shell: process.env.SHELL || "bash",
    platform: process.platform,
    home: os.homedir(),
  };
}
