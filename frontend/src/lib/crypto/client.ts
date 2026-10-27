import { isTauri, invoke } from "@tauri-apps/api/core";
import { UUID_PATTERN, type CryptoCommand, type CryptoReply, type DeliveryItem, type VaultRequest, type RevealRequest, type ApproveLinkRequest } from "./types";
import { currentCsrfToken } from "../api";
import { CryptoOperationError, publicCryptoError } from "./errors";

/** Shared bridge to the device-local Rust core, in a Worker or native vault. */
export class CryptoClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private readonly clientId = crypto.randomUUID();

  constructor(private readonly account: string, private readonly callId?: string) {
    if (!UUID_PATTERN.test(account)) throw new Error("Неверный аккаунт");
    this.startWorker();
  }

  private startWorker(): void {
    if (!isTauri() && !this.worker && !this.closed) {
      this.worker = this.callId
        ? new Worker(new URL("./callWorker.ts", import.meta.url), { type: "module", name: "coherent-call-crypto" })
        : new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "coherent-crypto" });
      this.worker.onmessage = (event: MessageEvent<{ id: string; result?: unknown; error?: string; code?: string }>) => {
        const request = this.pending.get(event.data.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(event.data.id);
        if (event.data.error) request.reject(new CryptoOperationError(event.data.code ?? "CRYPTO_UNAVAILABLE", event.data.error));
        else request.resolve(event.data.result);
      };
      this.worker.onerror = () => this.resetWorker(new Error("Криптопроцесс был перезапущен. Повтори действие"));
    }
  }

  private call<T>(request: VaultRequest | RevealRequest | ApproveLinkRequest): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Защищённое хранилище закрыто"));
    if (isTauri() && this.callId) return invoke<T>("desktop_call_crypto_request", { accountId:this.account, callId:this.callId, clientId:this.clientId, request });
    if (isTauri() && request.type === "approve_link") return invoke<T>("desktop_crypto_approve_link", { accountId: this.account, currentPassword: request.current_password, command: request.command });
    if (isTauri() && request.type === "reveal_recovery") return invoke<T>("desktop_crypto_reveal", { accountId: this.account, currentPassword: request.current_password });
    if (isTauri()) return invoke<T>("desktop_crypto_request", { accountId: this.account, request }).catch(reason => {
      const safe = publicCryptoError(new Error(typeof reason === "string" ? reason : ""));
      throw new CryptoOperationError(safe.code, safe.message);
    });
    this.startWorker();
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Защищённое хранилище закрыто"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.resetWorker(new CryptoOperationError("CRYPTO_TIMEOUT", "Защищённая операция не ответила вовремя. Повтори действие; очередь отправки сохранена.")), 60_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      worker.postMessage({ id, account: this.account, callId:this.callId, request });
    });
  }

  execute(command: CryptoCommand, deliveredId?: string, transport?: Record<string, unknown>): Promise<CryptoReply> {
    return this.call({ type: "execute", command, delivered_id: deliveredId, transport });
  }
  pendingDeliveries(): Promise<DeliveryItem[]> { return this.call({ type: "pending" }); }
  async revealRecovery(currentPassword: string): Promise<CryptoReply> {
    return this.call({ type: "reveal_recovery", current_password: currentPassword, csrf_token: isTauri() ? "" : await currentCsrfToken() });
  }
  async approveLink(currentPassword: string, command: ApproveLinkRequest["command"]): Promise<CryptoReply> {
    const reply = await this.call<CryptoReply>({ type: "approve_link", current_password: currentPassword, csrf_token: isTauri() ? "" : await currentCsrfToken(), command });
    if (reply.result.rejected) throw new Error("Одноразовый код не совпал. Получи новый код на новом устройстве.");
    return reply;
  }
  delivered(deliveryId: string): Promise<CryptoReply> { return this.call({ type: "delivered", delivery_id: deliveryId }); }
  private resetWorker(error: Error): void {
    this.worker?.terminate(); this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close(): void {
    this.closed = true;
    if (isTauri() && this.callId) void invoke("desktop_call_crypto_close", {accountId:this.account,callId:this.callId,clientId:this.clientId}).catch(() => {});
    this.resetWorker(new Error("Защищённое хранилище закрыто"));
  }
}
