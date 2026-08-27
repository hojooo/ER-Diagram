import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Bundle current workspace source in both the page and worker graphs instead of stale local dist.
    conditions: ["development"],
  },
});
