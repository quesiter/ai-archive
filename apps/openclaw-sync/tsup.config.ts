import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: ".cjs" }),
  noExternal: ["@ai-archive/contracts", "chokidar", "fast-glob", "zod"]
});
