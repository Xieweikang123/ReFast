import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    coverage: {
      provider: "v8",
      exclude: [
        "node_modules/**",
        "src-tauri/**",
        "dist/**",
        "coverage/**",
        "scripts/**",
        "**/*.config.{js,ts}",
        "**/__mocks__/**",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "src/main.tsx",
        "src/**/*.tsx", // 暂时排除组件文件，专注于工具函数测试
      ],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});

