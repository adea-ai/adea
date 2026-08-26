import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  publicDir: "../web/public",
  resolve: { dedupe: ["react", "react-dom"] },
});
