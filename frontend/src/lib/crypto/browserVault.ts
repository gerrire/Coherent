import { UUID_PATTERN, type DeliveryItem } from "./types";

interface StoredState { device: string; revision: number; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
export interface VaultContent { engine: number[]; outbox: DeliveryItem[] }

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(new Error("Не удалось открыть защищённое хранилище"));
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Не удалось сохранить защищённое хранилище"));
  });
}

/** Must run inside an exclusive Web Lock. All cryptography happens outside IDB
 * transactions; the final CAS write atomically stores MLS state and its outbox. */
export class BrowserVault {
  private constructor(private readonly database: IDBDatabase, private readonly account: string) {}

  static async open(account: string): Promise<BrowserVault> {
    if (!UUID_PATTERN.test(account) || !globalThis.isSecureContext || !navigator.locks || !globalThis.crypto?.subtle) {
      throw new Error("Для защищённой переписки нужен современный браузер и HTTPS");
    }
    const pending = indexedDB.open(`coherent-crypto-v1-${account}`, 1);
    pending.onupgradeneeded = () => pending.result.createObjectStore("vault");
    const database = await request(pending);
    database.onversionchange = () => database.close();
    return new BrowserVault(database, account);
  }

  private aad(device: string, revision: number): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`coherent/browser-vault/v1\0${this.account}\0${device}\0${revision}`);
  }

  async load(): Promise<{ key: CryptoKey; state: StoredState | null; content: VaultContent | null }> {
    const read = this.database.transaction("vault", "readonly");
    const done = completed(read);
    const keyRequest = request(read.objectStore("vault").get("key"));
    const stateRequest = request(read.objectStore("vault").get("state"));
    const [storedKey, state] = await Promise.all([keyRequest, stateRequest]) as [CryptoKey | undefined, StoredState | undefined];
    await done;
    if (!storedKey) {
      if (state) throw new Error("Ключ локального хранилища недоступен. Требуется восстановление доступа");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const write = this.database.transaction("vault", "readwrite", { durability: "strict" });
      const saved = completed(write);
      const existing = await request(write.objectStore("vault").get("key"));
      if (existing) { write.abort(); await saved.catch(() => {}); throw new Error("Хранилище изменилось в другой вкладке"); }
      write.objectStore("vault").add(key, "key");
      await saved;
      return { key, state: null, content: null };
    }
    if (!(storedKey instanceof CryptoKey) || storedKey.extractable || storedKey.algorithm.name !== "AES-GCM") throw new Error("Неверный ключ локального хранилища");
    if (!state) return { key: storedKey, state: null, content: null };
    if (!UUID_PATTERN.test(state.device) || !Number.isSafeInteger(state.revision) || state.revision < 1 || state.nonce.byteLength !== 12 || state.ciphertext.byteLength > 96 * 1024 * 1024) throw new Error("Повреждено локальное хранилище");
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: state.nonce, additionalData: this.aad(state.device, state.revision) }, storedKey, state.ciphertext));
    try {
      const content = JSON.parse(new TextDecoder().decode(bytes)) as VaultContent;
      if (!Array.isArray(content.engine) || !Array.isArray(content.outbox) || content.outbox.length > 100) throw new Error("Повреждено локальное хранилище");
      return { key: storedKey, state, content };
    } finally { bytes.fill(0); }
  }

  async save(key: CryptoKey, previous: StoredState | null, device: string, content: VaultContent): Promise<void> {
    const revision = (previous?.revision || 0) + 1;
    if (!Number.isSafeInteger(revision) || content.outbox.length > 100) throw new Error("Очередь защищённых сообщений заполнена");
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(content));
    let ciphertext: ArrayBuffer;
    try {
      if (plain.byteLength > 96 * 1024 * 1024) throw new Error("Локальное хранилище переполнено");
      ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: this.aad(device, revision) }, key, plain);
    } finally { plain.fill(0); }
    const write = this.database.transaction("vault", "readwrite", { durability: "strict" });
    const done = completed(write);
    const current = await request(write.objectStore("vault").get("state")) as StoredState | undefined;
    if ((current?.revision || 0) !== (previous?.revision || 0) || (current && current.device !== device)) {
      write.abort(); await done.catch(() => {}); throw new Error("Хранилище изменилось. Повтори действие");
    }
    write.objectStore("vault").put({ device, revision, nonce, ciphertext } satisfies StoredState, "state");
    await done;
  }

  close(): void { this.database.close(); }
}
