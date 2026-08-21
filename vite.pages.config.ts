import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist-pages",
    emptyOutDir: true,
    target: "es2022",
    reportCompressedSize: false,
    rollupOptions: {
      input: "pages-entry/index.html",
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
