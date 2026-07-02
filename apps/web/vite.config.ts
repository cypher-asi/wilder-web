import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/dev": "http://localhost:8080",
      "/assets": "http://localhost:8080",
      // Asset Lab dev server (npm run lab)
      "/lab": "http://localhost:8090",
      "/content": "http://localhost:8090",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
