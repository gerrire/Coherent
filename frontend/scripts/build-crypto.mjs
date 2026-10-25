import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(frontend, "..");
const crate = path.join(root, "crates/coherent-crypto");
const output = path.join(frontend, "public/crypto/v1");
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (child.error || child.status !== 0) throw new Error(`Crypto build failed: ${command}`);
}
run("cargo", ["build", "--locked", "--release", "--manifest-path", path.join(crate, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--features", "wasm"]);
// The CLI and the library must use the same wasm-bindgen schema version.
const cli = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8", shell: false });
if (cli.error || cli.status !== 0 || cli.stdout.trim() !== "wasm-bindgen 0.2.129") throw new Error("Install wasm-bindgen-cli 0.2.129 to match the locked library");
mkdirSync(output, { recursive: true });
run("wasm-bindgen", ["--target", "web", "--out-dir", output, "--out-name", "coherent_crypto", path.join(crate, "target/wasm32-unknown-unknown/release/coherent_crypto.wasm")]);
