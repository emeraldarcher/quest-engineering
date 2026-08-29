import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const controlPlane = process.env.QE_DEV_SERVER_URL ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": { target: controlPlane, changeOrigin: true },
      "/client": { target: controlPlane, ws: true, changeOrigin: true },
    },
  },
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["test/**/*.vitest.ts"],
  },
});
