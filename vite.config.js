import { defineConfig } from "vite";

const apiTarget = `http://localhost:${process.env.API_PORT || 3001}`;

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/firmware": apiTarget,
    },
  },
});
