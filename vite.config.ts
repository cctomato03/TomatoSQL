import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined>; platform: string };

// Tauri 会注入 TAURI_ENV_PLATFORM / TAURI_ENV_DEBUG 等变量
const host = process.env.TAURI_ENV_PLATFORM ?? process.platform;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: host === "windows" ? "chrome110" : "safari14",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    chunkSizeWarningLimit: 1600,
  },
});
