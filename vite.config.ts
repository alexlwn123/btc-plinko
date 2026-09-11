import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { sandboxNodeHandler } from "./server/mdkSandbox";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "payment-sandbox",
      configureServer(server) {
        const env = loadEnv(server.config.mode, server.config.root, "MDK_");
        for (const [key, value] of Object.entries(env)) {
          if (process.env[key] === undefined) process.env[key] = value;
        }
        server.middlewares.use("/api/mdk", sandboxNodeHandler);
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: false,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
