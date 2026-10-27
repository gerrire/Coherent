import { publicCryptoError } from "./errors";
import type { VaultRequest } from "./types";
declare const __COHERENT_CRYPTO_VERSION__: string;
interface Volatile { request(input: string): string; free(): void }
let client: Volatile | null = null;
let identity: string | null = null;
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{id:string;account:string;callId:string;request:VaultRequest}>) => {
  queue = queue.then(async () => {
    const {id,account,callId,request} = event.data;
    try {
      const scope = `${account}:${callId}`;
      if (identity && identity !== scope) throw new Error("Invalid call scope");
      if (!client) {
        const version = encodeURIComponent(__COHERENT_CRYPTO_VERSION__);
        const url = new URL(`/crypto/v1/coherent_crypto.js?v=${version}`, self.location.origin).href;
        const wasm = new URL(`/crypto/v1/coherent_crypto_bg.wasm?v=${version}`, self.location.origin).href;
        const module = await import(/* @vite-ignore */ url);
        await module.default({module_or_path:wasm});
        client = new module.EphemeralCallCrypto(account,callId); identity = scope;
      }
      self.postMessage({id,result:JSON.parse(client!.request(JSON.stringify(request)))});
    } catch (error) {
      const safe = publicCryptoError(error); self.postMessage({id,code:safe.code,error:safe.message});
    }
  });
};
