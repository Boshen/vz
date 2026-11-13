import { defineConfig } from "vite-plus";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidReact({ react: { compiler: true } })],
  test: { include: ["tests/**/*.test.ts", "packages/**/*.test.ts"], environment: "node" },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
