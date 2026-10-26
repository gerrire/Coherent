import { isTauri, invoke } from "@tauri-apps/api/core";
import { UUID_PATTERN, type CryptoCommand, type CryptoReply, type DeliveryItem, type VaultRequest, type RevealRequest } from "./types";
import { currentCsrfToken } from "../api";

/** Shared bridge to the device-local Rust core, in a Worker or native vault. */
export class CryptoClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();

  constructor(private readonly account: string) {
    if (!UUID_PATTERN.test(account)) throw new Error("Неверный аккаунт");
    if (!isTauri()) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "coherent-crypto" });
      this.worker.onmessage = (event: MessageEvent<{ id: string; result?: unknown; error?: string }>) => {
        const request = this.pending.get(event.data.id);
        if (!request) return;
        this.pending.delete(event.data.id);
        if (event.data.error) request.reject(new Error(event.data.error));
        else request.resolve(event.data.result);
      };
      this.worker.onerror = () => this.close();
    }
  }

  private call<T>(request: VaultRequest | RevealRequest): Promise<T> {
    if (isTauri() && request.type === "reveal_recovery") return invoke<T>("desktop_crypto_reveal", { accountId: this.account, currentPassword: request.current_password });
    if (isTauri()) return invoke<T>("desktop_crypto_request", { accountId: this.account, request });
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Защищённое хранилище закрыто"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      worker.postMessage({ id, account: this.account, request });
    });
  }

  execute(command: CryptoCommand, deliveredId?: string, transport?: Record<string, unknown>): Promise<CryptoReply> {
    return this.call({ type: "execute", command, delivered_id: deliveredId, transport });
  }
  pendingDeliveries(): Promise<DeliveryItem[]> { return this.call({ type: "pending" }); }
  async revealRecovery(currentPassword: string): Promise<CryptoReply> {
    return this.call({ type: "reveal_recovery", current_password: currentPassword, csrf_token: isTauri() ? "" : await currentCsrfToken() });
  }
  delivered(deliveryId: string): Promise<CryptoReply> { return this.call({ type: "delivered", delivery_id: deliveryId }); }
  close(): void {
    this.worker?.terminate(); this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error("Защищённое хранилище закрыто"));
    this.pending.clear();
  }
}
