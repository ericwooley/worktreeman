import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
    emptyOutDir: false,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@web": path.resolve(__dirname, "src/web"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5155,
    watch: {
      ignored: ["**/.bare/**", "**/dist/**"],
    },
  },
});
