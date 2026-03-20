import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime";

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, "dist", "web");
const outputPath = path.join(repoRoot, "src", "server", "generated", "embedded-web-assets.ts");

function normalizeContentType(filePath) {
  const detected = mime.lookup(filePath, "application/octet-stream");
  if (detected.startsWith("text/") || detected === "application/javascript" || detected === "application/json") {
    return `${detected}; charset=utf-8`;
  }

  return detected;
}

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, absolutePath));
      continue;
    }

    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    files.push({
      absolutePath,
      requestPath: `/${relativePath}`,
      contentType: normalizeContentType(absolutePath),
    });
  }

  return files;
}

const files = await collectFiles(webRoot);
const entries = await Promise.all(files.map(async (file) => ({
  requestPath: file.requestPath,
  contentType: file.contentType,
  data: (await fs.readFile(file.absolutePath)).toString("base64"),
})));

const output = `export interface EmbeddedWebAsset {
  contentType: string;
  data: string;
}

export const embeddedWebAssets = new Map<string, EmbeddedWebAsset>([
${entries.map((entry) => `  [${JSON.stringify(entry.requestPath)}, { contentType: ${JSON.stringify(entry.contentType)}, data: ${JSON.stringify(entry.data)} }],`).join("\n")}
]);
`;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, output, "utf8");
