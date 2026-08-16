import { defineConfig } from "vite";

// 多页面：note-window / settings（HTML 在 src/ 下，input 相对项目根）
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "note-window": "src/note-window/index.html",
        settings: "src/settings/index.html",
        "calendar-window": "src/calendar-window/index.html",
        "clock-window": "src/clock-window/index.html",
      },
    },
  },
});
