import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.VITE_MULTIMODAL_PORT || "13107");
  const apiTarget = env.VITE_MULTIMODAL_API || "http://127.0.0.1:13107";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@brand": path.resolve(__dirname, "../../shared/brand"),
      },
    },
    server: {
      port,
      strictPort: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
        "/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
