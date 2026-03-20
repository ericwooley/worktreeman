import fs from "node:fs";
import process from "node:process";
import tty from "node:tty";
import { createRequire } from "node:module";
import ptyAddonPath from "../../../node_modules/node-pty/build/Release/pty.node" with { type: "file" };

interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number | null; signal?: number }) => void): { dispose(): void };
}

interface UnixPtyProcessInfo {
  fd: number;
  pid: number;
  pty: string;
}

interface UnixPtyNative {
  fork(
    file: string,
    args: string[],
    parsedEnv: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    useUtf8: boolean,
    helperPath: string,
    onExitCallback: (code: number, signal: number) => void,
  ): UnixPtyProcessInfo;
  resize(fd: number, cols: number, rows: number): void;
}

const require = createRequire(import.meta.url);
const native = require(ptyAddonPath) as UnixPtyNative;

class BunPtyProcess implements PtyProcess {
  readonly pid: number;

  private readonly fd: number;
  private readonly socket: tty.ReadStream;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number | null; signal?: number }) => void>();
  private closed = false;

  constructor(file: string, args: string[], options: PtySpawnOptions) {
    const parsedEnv = Object.entries(options.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `${key}=${value}`);

    const term = native.fork(
      file,
      args,
      parsedEnv,
      options.cwd,
      options.cols,
      options.rows,
      -1,
      -1,
      true,
      "",
      (code, signal) => {
        this.closed = true;
        for (const listener of this.exitListeners) {
          listener({ exitCode: code, signal });
        }
      },
    );

    this.pid = term.pid;
    this.fd = term.fd;
    this.socket = new tty.ReadStream(term.fd);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });
    this.socket.on("error", (error) => {
      const code = typeof error === "object" && error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code.includes("EIO") || code.includes("EAGAIN")) {
        return;
      }

      throw error;
    });
  }

  write(data: string): void {
    fs.write(this.fd, data, (error) => {
      if (!error) {
        return;
      }

      const code = typeof error.code === "string" ? error.code : "";
      if (code === "EIO" || code === "ERR_STREAM_DESTROYED") {
        return;
      }

      throw error;
    });
  }

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || Number.isNaN(cols) || Number.isNaN(rows)) {
      throw new Error("resizing must be done using positive cols and rows");
    }

    native.resize(this.fd, cols, rows);
  }

  kill(signal?: string): void {
    if (this.closed) {
      return;
    }

    try {
      process.kill(this.pid, signal ?? "SIGHUP");
    } catch {
      return;
    }
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number | null; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
}

export function spawnPty(file: string, args: string[], options: PtySpawnOptions): PtyProcess {
  if (process.platform === "win32") {
    throw new Error("Compiled terminal sessions are not supported on Windows yet.");
  }

  return new BunPtyProcess(file, args, options);
}
