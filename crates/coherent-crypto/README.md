# Coherent shared cryptography

Experimental client core for browser WASM and native clients. **Not yet connected
to production chats.** See [implementation status](../../docs/crypto-implementation.md)
and [architecture](../../docs/security-mls.md) for remaining release requirements.

- RFC 9420: OpenMLS 0.9.2, stable APIs only.
- `engine::CryptoEngine`: transactional JSON commands, encrypted content and
  per-account history key archive, local recovery primitives.
- `wasm`: Worker-only browser binding; snapshot bytes must be sealed locally.
- `native-vault`: OS keystore wrapping key, authenticated local file and outbox.
- `VaultKeyStore`: platform adapter interface for Android/iOS native stores.

Never log commands, recovery phrases, content or snapshots. Never upload a local
snapshot or clone it to another device. Only opaque network envelopes belong in
the delivery service. Pinning an unverified server device list defeats E2EE.

Compile (Rust 1.99.1):

```sh
cargo check --locked --features native-vault
cargo check --locked --target wasm32-unknown-unknown --features wasm
```
