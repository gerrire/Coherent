/** Downloads public model files directly to this device, never through the API. */
export type ModelLoadErrorCode = "network" | "timeout" | "http" | "invalid-model" | "memory" | "runtime";
export interface ModelLoadErrorInfo {
  code: ModelLoadErrorCode;
  message: string;
  retryable: boolean;
  file?: string;
  status?: number;
}

export class ModelDownloadError extends Error implements ModelLoadErrorInfo {
  constructor(
    public code: ModelLoadErrorCode,
    message: string,
    public retryable: boolean,
    public file?: string,
    public status?: number,
  ) { super(message); this.name = "ModelDownloadError"; }
}

function filename(url: string): string | undefined {
  try { return new URL(url).pathname.split("/").pop()?.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100); }
  catch { return undefined; }
}

/** Only known public Hub downloads get the retry policy; application/API calls do not. */
export function isPublicModelUrl(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.protocol === "https:" && (
      url.hostname === "huggingface.co" && /^\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//i.test(url.pathname)
      || url.hostname === "raw.githubusercontent.com"
        && /^\/snakers4\/silero-vad\/[0-9a-f]{40}\/src\/silero_vad\/data\/silero_vad\.onnx$/i.test(url.pathname)
    );
  } catch { return false; }
}

function httpError(status: number, file?: string): ModelDownloadError {
  const reason = status === 401 || status === 403
    ? "Источник моделей отклонил скачивание. Проверь доступ к источнику; модель не переносится на сервер."
    : status === 404 ? "Файл модели не найден у источника. Обнови страницу и повтори загрузку."
    : status === 429 ? "Источник моделей временно ограничил скачивание. Подожди и повтори."
    : "Источник моделей временно недоступен. Повтори загрузку.";
  return new ModelDownloadError("http", `${reason} Код ${status}${file ? ` · ${file}` : ""}.`,
    status === 408 || status === 429 || status >= 500, file, status);
}

function timeoutError(file?: string): ModelDownloadError {
  return new ModelDownloadError("timeout", `Скачивание модели остановилось${file ? ` · ${file}` : ""}. Проверь соединение и повтори загрузку.`, true, file);
}

function networkError(file?: string): ModelDownloadError {
  return new ModelDownloadError("network", `Не удалось скачать модель${file ? ` · ${file}` : ""}. Проверь доступ к источнику (Hugging Face / GitHub) и соединение с сетью, затем повтори.`, true, file);
}

function aborted(): DOMException { return new DOMException("Download cancelled", "AbortError"); }
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw aborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export interface ModelFetchOptions { attempts?: number; timeoutMs?: number; retryDelayMs?: number }

/** Bounded retries before a body is handed to the caller, plus an idle body timeout.
 * cache:reload avoids reusing a browser-cached expired signed Hub redirect.
 * We never buffer another whole ASR model in this wrapper. */
export function createModelDownloadFetch(
  fetcher: typeof fetch,
  { attempts = 3, timeoutMs = 30_000, retryDelayMs = 500 }: ModelFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    if (!isPublicModelUrl(input)) return fetcher(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const file = filename(url);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (callerSignal?.aborted) throw aborted();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      callerSignal?.addEventListener("abort", cancel, { once: true });
      let timedOut = false;
      let timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const dispose = () => { clearTimeout(timer); callerSignal?.removeEventListener("abort", cancel); };
      try {
        const response = await fetcher(input, { ...init, cache: "reload", signal: controller.signal });
        clearTimeout(timer);
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          throw httpError(response.status, file);
        }
        // Optional metadata files legitimately return 404. Preserve that response
        // so Transformers.js can distinguish optional files from required ones.
        if (response.status !== 200 || !response.body) { dispose(); return response; }
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({
          async pull(sink) {
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            try {
              const chunk = await reader.read();
              clearTimeout(timer);
              if (chunk.done) { dispose(); sink.close(); }
              else sink.enqueue(chunk.value);
            } catch {
              dispose();
              sink.error(callerSignal?.aborted ? aborted() : timedOut ? timeoutError(file) : networkError(file));
            }
          },
          async cancel(reason) { dispose(); controller.abort(); await reader.cancel(reason).catch(() => undefined); },
        });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        dispose();
        if (callerSignal?.aborted) throw aborted();
        const safe = error instanceof ModelDownloadError ? error : timedOut ? timeoutError(file) : networkError(file);
        if (!safe.retryable || attempt + 1 >= attempts) throw safe;
        await delay(retryDelayMs * 2 ** attempt, callerSignal ?? undefined);
      }
    }
    throw networkError(file);
  };
}

const FETCH_WRAPPED = Symbol.for("coherent.model-download-fetch");
export function installModelDownloadFetch(): void {
  const current = globalThis.fetch as typeof fetch & { [FETCH_WRAPPED]?: boolean };
  if (current[FETCH_WRAPPED]) return;
  const wrapped = createModelDownloadFetch(current.bind(globalThis)) as typeof current;
  Object.defineProperty(wrapped, FETCH_WRAPPED, { value: true });
  globalThis.fetch = wrapped;
}

/** Removes only this pinned model's own entries, never other browser/app data. */
export async function evictPinnedModelCache(repository: string, revision: string): Promise<void> {
  if (typeof caches === "undefined" || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/i.test(revision)) return;
  const prefix = `https://huggingface.co/${repository}/resolve/${revision}/`;
  for (const name of ["transformers-cache", "coherent-model-assets-v1"]) {
    try {
      const cache = await caches.open(name);
      const entries = await cache.keys();
      await Promise.all(entries.filter(entry => entry.url.startsWith(prefix)).map(entry => cache.delete(entry)));
    } catch { /* Cache can be unavailable in private browsing; downloads still work. */ }
  }
}

export async function evictModelAsset(url: string, cacheName = "coherent-model-assets-v1"): Promise<void> {
  if (typeof caches === "undefined" || !isPublicModelUrl(url)) return;
  try { await (await caches.open(cacheName)).delete(url); } catch { /* Optional cache. */ }
}

export function modelLoadError(error: unknown): ModelLoadErrorInfo {
  if (error instanceof ModelDownloadError) return { code: error.code, message: error.message, retryable: error.retryable, file: error.file, status: error.status };
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|memory access out of bounds|cannot enlarge memory|allocation failed|bad_alloc/i.test(message)) {
    return { code: "memory", message: "Для модели не хватило памяти. Выбери Whisper Tiny, отключи нейросетевой голос или оставь только приём.", retryable: false };
  }
  if (/protobuf|invalid wire|unexpected token|JSON|invalid model|invalid graph|model.*(corrupt|invalid)|parse.*(model|onnx)|deserialize/i.test(message)) {
    return { code: "invalid-model", message: "Файл модели повреждён или имеет неверный формат. Повтори загрузку; повреждённые файлы этой модели будут скачаны заново.", retryable: true };
  }
  const status = message.match(/(?:status|error|access|file)[^\d]{0,25}(401|403|404|408|429|5\d\d)/i)?.[1];
  if (status) return modelLoadError(httpError(Number(status)));
  if (/unauthorized|access.*denied|forbidden/i.test(message)) return modelLoadError(httpError(403));
  if (/could not locate file|file.*not found/i.test(message)) return modelLoadError(httpError(404));
  if (/timeout|timed out|AbortError/i.test(message)) return modelLoadError(timeoutError());
  if (/fetch|network|download|load.*file|connection/i.test(message)) return modelLoadError(networkError());
  return { code: "runtime", message: "Не удалось запустить модель. Обнови страницу; если ошибка повторяется, выбери модель поменьше.", retryable: true };
}

export interface ModelAssetOptions {
  signal?: AbortSignal;
  onProgress?(progress: number): void;
  expectedBytes?: number;
  maxBytes?: number;
  sha256?: string;
  cacheName?: string;
}

function invalidAsset(file?: string): ModelDownloadError {
  return new ModelDownloadError("invalid-model", `Скачанный файл модели повреждён${file ? ` · ${file}` : ""}. Повтори загрузку.`, true, file);
}

async function verifyAsset(bytes: ArrayBuffer, url: string, options: ModelAssetOptions): Promise<void> {
  if (!bytes.byteLength || bytes.byteLength > (options.maxBytes ?? 300_000_000)
      || options.expectedBytes !== undefined && bytes.byteLength !== options.expectedBytes) throw invalidAsset(filename(url));
  if (/\.onnx(?:\?|$)/i.test(url) && /^\s*<(?:!doctype|html)/i.test(new TextDecoder().decode(bytes.slice(0, 80)))) throw invalidAsset(filename(url));
  if (options.sha256) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== options.sha256.toLowerCase()) throw invalidAsset(filename(url));
  }
}

/** Shared helper for small VAD/voice files. Quota/security errors only disable
 * caching; a successfully downloaded model can still run in this session. */
export async function fetchModelAsset(url: string, options: ModelAssetOptions = {}): Promise<ArrayBuffer> {
  if (!isPublicModelUrl(url)) throw new ModelDownloadError("http", "Недопустимый источник файла модели.", false);
  if (options.signal?.aborted) throw aborted();
  let cache: Cache | undefined;
  try { if (typeof caches !== "undefined") cache = await caches.open(options.cacheName ?? "coherent-model-assets-v1"); } catch { /* Optional cache. */ }
  try {
    const cached = await cache?.match(url);
    if (cached?.ok) {
      try { const bytes = await cached.arrayBuffer(); await verifyAsset(bytes, url, options); options.onProgress?.(100); return bytes; }
      catch { await cache?.delete(url).catch(() => false); }
    }
  } catch { /* Do not make private browsing/cache failure fatal. */ }
  // The fetch wrapper retries only transient status/network failures. An asset
  // integrity error gets one fresh body download, without clearing other files.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.signal?.aborted) throw aborted();
    const currentFetch = globalThis.fetch as typeof fetch & { [FETCH_WRAPPED]?: boolean };
    const downloader = currentFetch[FETCH_WRAPPED] ? currentFetch : createModelDownloadFetch(currentFetch.bind(globalThis));
    const response = await downloader(url, { signal: options.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw httpError(response.status, filename(url));
    const total = Number(response.headers.get("content-length")) || options.expectedBytes || 0;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > (options.maxBytes ?? 300_000_000)) { await reader.cancel(); throw invalidAsset(filename(url)); }
          chunks.push(value);
          if (total) options.onProgress?.(Math.min(99, length / total * 100));
        }
      } else { const bytes = new Uint8Array(await response.arrayBuffer()); chunks.push(bytes); length = bytes.length; }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      await verifyAsset(result.buffer, url, options);
      try { await cache?.put(url, new Response(result, { headers: response.headers })); } catch { /* Full disk does not invalidate the already loaded model. */ }
      options.onProgress?.(100);
      return result.buffer;
    } catch (error) {
      if (options.signal?.aborted) throw aborted();
      if (attempt === 0 && error instanceof ModelDownloadError && error.retryable) continue;
      throw error instanceof ModelDownloadError ? error : networkError(filename(url));
    }
  }
  throw invalidAsset(filename(url));
}
