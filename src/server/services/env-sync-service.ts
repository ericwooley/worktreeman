import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".bare",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

export interface EnvSyncResult {
  copiedFiles: string[];
}

export async function syncEnvFiles(sourceRoot: string, targetRoot: string): Promise<EnvSyncResult> {
  const copiedFiles: string[] = [];

  await copyEnvFilesRecursive(sourceRoot, targetRoot, sourceRoot, copiedFiles);

  return {
    copiedFiles: copiedFiles.sort(),
  };
}

async function copyEnvFilesRecursive(
  currentSourceDir: string,
  targetRoot: string,
  sourceRoot: string,
  copiedFiles: string[],
): Promise<void> {
  const entries = await fs.readdir(currentSourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await copyEnvFilesRecursive(path.join(currentSourceDir, entry.name), targetRoot, sourceRoot, copiedFiles);
      continue;
    }

    if (!entry.isFile() || !entry.name.startsWith(".env")) {
      continue;
    }

    const sourcePath = path.join(currentSourceDir, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);
    const targetPath = path.join(targetRoot, relativePath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    copiedFiles.push(relativePath);
  }
}
