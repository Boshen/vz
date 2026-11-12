import { defineConfig } from "vite-plus";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidReact({ react: { compiler: true } })],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
