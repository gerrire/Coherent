import { build } from "vite";
import { fileURLToPath } from "node:url";

// Compile the currently isolated bridge and Worker as well as the ordinary
// application. It stays separate until E2EE chat integration is complete.
await build({
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
