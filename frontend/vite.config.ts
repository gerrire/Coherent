import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let cryptoVersion = "unbuilt";
try {
  cryptoVersion = createHash("sha256").update(readFileSync(new URL("./public/crypto/v1/coherent_crypto.js", import.meta.url)))
    .update(readFileSync(new URL("./public/crypto/v1/coherent_crypto_bg.wasm", import.meta.url))).digest("hex").slice(0, 20);
} catch { /* Standalone TypeScript CI does not execute the WASM bridge. */ }

export default defineConfig({
  define: { __COHERENT_CRYPTO_VERSION__: JSON.stringify(cryptoVersion) },
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
