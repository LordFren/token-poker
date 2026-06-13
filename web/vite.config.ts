import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite serves the app on :5173 and proxies the Socket.IO and REST
// calls to the local Node server on :3000. In prod the Node server serves the
// built assets directly, so these proxies are dev-only.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/socket.io": { target: "http://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
