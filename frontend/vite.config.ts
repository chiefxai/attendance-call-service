import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: { proxy: { "/api/call-service": { target: env.VITE_BACKEND_ORIGIN || "http://localhost:3000", changeOrigin: true } } },
  };
});
