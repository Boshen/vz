import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], environment: "node", fileParallelism: false },
});
