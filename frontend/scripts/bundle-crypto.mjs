import { build } from "vite";
import { fileURLToPath } from "node:url";

// Compile the shared bridge and browser Worker independently for CI.
await build({
  define: { __COHERENT_CRYPTO_VERSION__: JSON.stringify("standalone-ci") },
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  publicDir: false,
  build: {
    outDir: "crypto-dist",
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("../src/lib/crypto/client.ts", import.meta.url)),
      formats: ["es"],
      fileName: "crypto-client",
    },
  },
});
