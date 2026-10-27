import { attachmentObjectUrl } from "../api";
import { CryptoClient } from "./client";
import type { Envelope, MessageContext } from "./types";

export interface PublicCipherFile { id: string; byte_size: number; digest: string }
export interface SecureFile {
  id: string; name: string; media_type: string; size: number; count: number;
  key: string; context: MessageContext; cipher_size: number; digest: string;
}
const CHUNK = 1024 * 1024;
const MAGIC = new TextEncoder().encode("CohFile1");
export function fromBase64(value: string): Uint8Array<ArrayBuffer> { const text = atob(value); return Uint8Array.from(text, char => char.charCodeAt(0)); }
export function toBase64(value: Uint8Array<ArrayBuffer>): string { let text = ""; for (let i = 0; i < value.length; i += 16384) text += String.fromCharCode(...value.subarray(i, i + 16384)); return btoa(text); }
async function digest(blob: Blob): Promise<string> { return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))); }
function idb<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error("Не удалось сохранить очередь файлов")); }); }
async function database(): Promise<IDBDatabase> { const req = indexedDB.open("coherent-mls-cipher-uploads-v1", 1); req.onupgradeneeded = () => req.result.createObjectStore("files", { keyPath: "id" }); return idb(req); }
interface CachedCipher { id: string; created: number; data?: ArrayBuffer; blob?: Blob }
async function cache(account: string, id: string, blob: Blob): Promise<void> {
  // WebKit can reject Blob writes to IndexedDB. Persist ciphertext bytes and
  // keep every write inside the request callback, while its transaction is live.
  const data = await blob.arrayBuffer();
  const db = await database();
  try {
    const tx = db.transaction("files", "readwrite", { durability: "strict" });
    let failure: Error | undefined;
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(failure ?? new Error("Не удалось сохранить очередь файлов")); });
    const store = tx.objectStore("files"), existing = store.getAll();
    existing.onsuccess = () => {
      try {
        let used = 0;
        for (const value of existing.result as CachedCipher[]) {
          const size = value.data?.byteLength ?? value.blob?.size;
          if (value.created < Date.now() - 3 * 86400000 || size === undefined) store.delete(value.id);
          else used += size;
        }
        if (used + data.byteLength > 100 * 1024 * 1024) throw new Error("Слишком много неотправленных файлов. Сначала повтори их отправку");
        store.put({ id: `${account}:${id}`, created: Date.now(), data } satisfies CachedCipher);
      } catch (reason) { failure = reason instanceof Error ? reason : new Error("Очередь файлов недоступна"); tx.abort(); }
    };
    await done;
  } finally { db.close(); }
}
export async function cachedCipher(account: string, id: string): Promise<Blob> {
  const db = await database();
  try { const value = await idb(db.transaction("files").objectStore("files").get(`${account}:${id}`)) as CachedCipher | undefined; if (value?.data) return new Blob([value.data], {type:"application/octet-stream"}); if (value?.blob) return value.blob; throw new Error("Зашифрованный файл отсутствует в очереди. Прикрепи его заново"); }
  finally { db.close(); }
}
export async function forgetCipher(account: string, ids: string[]): Promise<void> {
  const db = await database(); try { const tx = db.transaction("files", "readwrite"); for (const id of ids) tx.objectStore("files").delete(`${account}:${id}`); await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new Error("Очередь файлов недоступна")); }); } finally { db.close(); }
}

export async function sealFiles(client: CryptoClient, account: string, context: MessageContext, files: File[]): Promise<{ metadata: SecureFile[]; publicFiles: PublicCipherFile[] }> {
  const metadata: SecureFile[] = []; const publicFiles: PublicCipherFile[] = [];
  try {
    for (const file of files) {
      if (!file.size || file.size > 25 * CHUNK) throw new Error("Размер файла: от 1 байта до 25 МБ");
      const id = crypto.randomUUID(); const count = Math.ceil(file.size / CHUNK); const chunks: BlobPart[] = [MAGIC]; let key: string | null = null;
      for (let index = 0; index < count; index++) {
        const bytes = new Uint8Array(await file.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer());
        const result = await client.execute({ operation: "seal_chunk", context, file_id: id, index, count, key, data: toBase64(bytes) }); bytes.fill(0);
        key = result.result.key as string; const envelope = result.result.envelope as Envelope;
        const ciphertext = fromBase64(envelope.ciphertext); const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, ciphertext.length, false);
        chunks.push(fromBase64(envelope.nonce), length, ciphertext);
      }
      const blob = new Blob(chunks, { type: "application/octet-stream" }); const hash = await digest(blob);
      await cache(account, id, blob);
      metadata.push({ id, name: file.name.slice(0, 255), media_type: file.type.slice(0, 100), size: file.size, count, key: key!, context, cipher_size: blob.size, digest: hash });
      publicFiles.push({ id, byte_size: blob.size, digest: hash });
    }
    return { metadata, publicFiles };
  } catch (error) { await forgetCipher(account, publicFiles.map(file => file.id)).catch(() => {}); throw error; }
}

export async function openCipherFile(client: CryptoClient, path: string, meta: SecureFile): Promise<string> {
  if (!Number.isInteger(meta.count) || meta.count < 1 || meta.count > 25 || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > 25 * CHUNK) throw new Error("Некорректные данные вложения");
  const source = await attachmentObjectUrl(path);
  try {
    const response = await fetch(source, { credentials: "include" }); if (!response.ok) throw new Error(response.status === 404 ? "Вложение удалено" : "Не удалось загрузить вложение");
    const encrypted = await response.blob(); if (encrypted.size !== meta.cipher_size || await digest(encrypted) !== meta.digest) throw new Error("Файл повреждён");
    const bytes = new Uint8Array(await encrypted.arrayBuffer()); if (!MAGIC.every((value, index) => bytes[index] === value)) throw new Error("Неизвестный формат вложения");
    let offset = MAGIC.length; let size = 0; const chunks: BlobPart[] = [];
    for (let index = 0; index < meta.count; index++) {
      if (offset + 16 > bytes.length) throw new Error("Файл обрезан");
      const nonce = toBase64(bytes.slice(offset, offset + 12)); offset += 12;
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false); offset += 4;
      if (length < 17 || length > CHUNK + 16 || offset + length > bytes.length) throw new Error("Некорректный блок вложения");
      const envelope: Envelope = { version: 1, nonce, ciphertext: toBase64(bytes.slice(offset, offset + length)) }; offset += length;
      const result = await client.execute({ operation: "open_chunk", context: meta.context, file_id: meta.id, index, count: meta.count, key: meta.key, envelope });
      const plain = fromBase64(result.result.data as string); size += plain.length; chunks.push(plain);
    }
    if (offset !== bytes.length || size !== meta.size) throw new Error("Размер расшифрованного файла не совпадает");
    const allowed = /^(image\/(png|jpeg|gif|webp|avif|heic|heif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm))$/;
    return URL.createObjectURL(new Blob(chunks, { type: allowed.test(meta.media_type) ? meta.media_type : "application/octet-stream" }));
  } finally { if (source.startsWith("blob:")) URL.revokeObjectURL(source); }
}
