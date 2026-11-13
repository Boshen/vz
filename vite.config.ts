import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { voidPlugin } from "void";
import vz from "./packages/vite-plugin-vz/src/index";
import { voidReact } from "@void/react/plugin";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    tailwindcss(),
    voidPlugin(),
    voidReact({ react: { compiler: true } }),
    vz({
      endpoint: process.env.VZ_ENDPOINT ?? "https://vz.void.app",
      project: "vz",
      enabled: process.env.VZ_UPLOAD === "true",
      strict: true,
    }),
  ],
  test: { include: ["tests/**/*.test.ts", "packages/**/*.test.ts"], environment: "node" },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
