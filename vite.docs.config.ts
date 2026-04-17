import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const docsRoot = path.resolve(__dirname, "docs");
const docsOutputRoot = path.resolve(__dirname, "dist/docs");

function docSlugs() {
  return fs
    .readdirSync(docsRoot)
    .filter((entry) => entry.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => entry.replace(/\.md$/, "").replace(/^\d+-/, ""));
}

function emitDocPages(): Plugin {
  return {
    name: "emit-doc-pages",
    closeBundle() {
      const indexHtmlPath = path.join(docsOutputRoot, "index.html");
      const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");

      for (const slug of docSlugs()) {
        const targetDir = path.join(docsOutputRoot, slug);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, "index.html"), indexHtml);
      }
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, "docs-site"),
  publicDir: path.resolve(__dirname, "public"),
  base: process.env.DOCS_BASE ?? "/",
  plugins: [react(), emitDocPages()],
  build: {
    outDir: path.resolve(__dirname, "dist/docs"),
    emptyOutDir: false,
  },
  server: {
    watch: {
      ignored: ["**/dist/**", "**/.bare/**"],
    },
  },
});
