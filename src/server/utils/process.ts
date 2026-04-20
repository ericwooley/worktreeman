import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowExitCodes?: number[];
  stdin?: string | Uint8Array;
}

export async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (typeof options.stdin === "string") {
      child.stdin.end(options.stdin);
    } else if (options.stdin instanceof Uint8Array) {
      child.stdin.end(Buffer.from(options.stdin));
    } else {
      child.stdin.end();
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowExitCodes?.includes(code ?? -1)) {
        resolve({ stdout, stderr, exitCode: code ?? null });
        return;
      }

      reject(
        new Error(
          `Command failed (${command} ${args.join(" ")}) with code ${code ?? "unknown"}: ${stderr || stdout}`,
        ),
      );
    });
  });
}
