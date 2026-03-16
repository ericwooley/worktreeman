import os from "node:os";
import process from "node:process";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import pty from "node-pty";
import type { TerminalClientMessage, TerminalServerMessage, WorktreeRuntime } from "../../shared/types.js";
import { runCommand } from "../utils/process.js";

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

export async function killTmuxSession(runtime: WorktreeRuntime): Promise<void> {
  if (!(await hasTmuxSession(runtime.tmuxSession, runtime.worktreePath))) {
    return;
  }

  await runCommand("tmux", ["kill-session", "-t", runtime.tmuxSession], {
    cwd: runtime.worktreePath,
  });
}

export function createTerminalService(options: TerminalServiceOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

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

    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");

    try {
      await ensureTmuxSession(runtime, shell);
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

    send(socket, { type: "ready", session: runtime.tmuxSession });

    term.onData((data) => {
      send(socket, { type: "output", data });
    });

    term.onExit(({ exitCode }) => {
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
