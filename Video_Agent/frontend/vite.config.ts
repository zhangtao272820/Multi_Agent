import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 与后端默认错开常用端口；可在 frontend/.env 里改 VITE_* 覆盖 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.VITE_VIDEO_AGENT_PORT || "56291");
  const apiTarget = env.VITE_VIDEO_AGENT_API || "http://127.0.0.1:37891";
  const wsTarget = env.VITE_VIDEO_AGENT_WS || "ws://127.0.0.1:37891";

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
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
        "/ws": {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});
