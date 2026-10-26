import { isTauri } from "@tauri-apps/api/core";
import { attachmentObjectUrl, api, apiRequest, ApiError, type Conversation, type Message } from "../api";
import { CryptoClient } from "./client";
import { enrollCurrentDevice } from "./access";
import { cachedCipher, forgetCipher, openCipherFile, sealFiles, type PublicCipherFile, type SecureFile } from "./files";
import type { ContactPin, CryptoCommand, DeliveryItem, DeviceBinding, Envelope, HistoryBackup, MessageContext, SignedRoster } from "./types";

interface AccountDirectory { account_id: string; public_key: string | null; ready: boolean; rosters: SignedRoster[] }
interface GroupState { group_id: string | null; sequence: number; epoch: number; generation: number; roster: string[] }
interface Directory { accounts: AccountDirectory[]; state: GroupState; eligible_devices: string[] }
interface Lease {
  accepted: boolean; event?: SecureEvent; lease_id: string; nonce: string; request_id: string;
  operation: "init" | "add" | "reset" | "message"; group_id: string; expected_sequence: number; previous_epoch: number;
  roster: string[]; targets: string[]; packages: Array<{ id: string; device_id: string; wire: string }>;
}
interface Hint { conversation_id: string; lease: Lease; files: PublicCipherFile[]; migration?: { source_files: string[] } }
interface Packet { context: MessageContext; epoch: number; wire: string; body: Envelope; backups: Record<string, HistoryBackup> }
interface Operation {
  version: 1; conversation_id: string; group_id: string; request_id: string; lease_id: string; expected_sequence: number;
  operation: Lease["operation"] | "migrate"; previous_epoch: number; roster: string[]; targets: string[]; package_ids: string[];
  commit: string | null; welcome: string | null; message: Packet | null; files: PublicCipherFile[]; source_files: string[] | null;
}
export interface SecureEvent { id: string; sequence: number; payload: string; nonce: string; proof: string; sender: DeviceBinding; created_at: string }
export interface KeyReview { account_id: string; fingerprint: string }
export class MessagingAccessError extends Error {
  constructor(readonly kind: "device" | "setup" | "verify" | "waiting" | "changed", message: string, readonly reviews: KeyReview[] = []) { super(message); }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function same(first: string[], second: string[]): boolean { return first.length === second.length && [...first].sort().every((item, index) => item === [...second].sort()[index]); }
function hint(item: DeliveryItem): Hint | null { return (item.payload.transport as Hint | undefined) ?? null; }
const pause = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export class MlsMessaging {
  readonly crypto: CryptoClient;
  private device: DeviceBinding | null = null;
  private initialization: Promise<void> | null = null;
  private acquired = new Map<string, { conversation: Conversation; lease: Lease }>();
  private migrations = new Map<string, Promise<void>>();
  private migrated = new Set<string>();
  private decoded = new Map<string, { signature: string; message: Message }>();
  constructor(readonly account: string) { this.crypto = new CryptoClient(account); }
  close() { this.crypto.close(); this.decoded.clear(); }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      try { return await work(); }
      finally {
        const leases = [...this.acquired.values()]; this.acquired.clear();
        if (leases.length) {
          const pending = await this.crypto.pendingDeliveries().catch(() => null);
          if (pending) for (const entry of leases) {
            if (!pending.some(item => hint(item)?.lease.lease_id === entry.lease.lease_id)) await this.cancelLease(entry.conversation.id, entry.lease).catch(() => {});
          }
        }
      }
    };
    if (navigator.locks) return navigator.locks.request(`coherent-transport-v1-${this.account}`, { mode: "exclusive" }, guarded);
    if (!isTauri()) throw new MessagingAccessError("device", "Для защищённой переписки нужен современный браузер и HTTPS");
    return guarded();
  }
  private async challenge() {
    for (let attempt = 0; ; attempt++) {
      try { return await api.deviceChallenge("action"); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 2) throw error; await pause(2100); }
    }
  }
  private async ready(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const status = await api.securityStatus();
      if (!status.configured) throw new MessagingAccessError("setup", "Настрой ключ восстановления в профиле, чтобы открыть защищённую переписку");
      const identity = await this.crypto.execute({ operation: "identity" }); this.device = identity.result.device as DeviceBinding;
      if (!status.devices.some(d => d.id === this.device!.device_id)) throw new MessagingAccessError("device", "Подтверди это устройство на другом устройстве или ключом восстановления");
      await enrollCurrentDevice(this.crypto, "");
      const saved = await apiRequest<{ pins: ContactPin[] }>("/api/v1/security/contacts");
      await this.crypto.execute({ operation: "import_contact_pins", pins: saved.pins });
      await this.packages();
    })().catch(error => { this.initialization = null; throw error; });
    return this.initialization;
  }
  private async packages(): Promise<void> {
    const device = this.device!;
    const count = await apiRequest<{ available: number }>(`/api/v1/security/key-packages/count?device_id=${device.device_id}`);
    let pending = (await this.crypto.pendingDeliveries()).filter(item => item.operation === "key_package").slice(0, 16);
    if (count.available < 8) {
      for (let i = pending.length; i < 16; i++) await this.crypto.execute({ operation: "key_package" });
      pending = (await this.crypto.pendingDeliveries()).filter(item => item.operation === "key_package").slice(0, 16);
    }
    if (!pending.length) return;
    const payload = canonical({ operation: "publish_packages", packages: pending.map(item => item.payload.key_package) });
    const challenge = await this.challenge(); const signed = await this.crypto.execute({ operation: "sign_action", nonce: challenge.nonce, payload });
    try { await apiRequest("/api/v1/security/key-packages", { method: "POST", body: JSON.stringify({ challenge_id: challenge.challenge_id, device, proof: signed.result.proof, payload }) }); }
    catch (error) { if (error instanceof ApiError && error.status === 409 && error.message.includes("заполнен")) return; throw error; }
    for (const item of pending) await this.crypto.delivered(item.id);
  }
  async refreshKeys(): Promise<void> { return this.lock(async () => { await this.ready(); await this.packages(); }); }
  async initialize(): Promise<void> { return this.lock(() => this.ready()); }
  private async checkDirectory(conversation: Conversation, confirmed?: KeyReview[]): Promise<Directory> {
    const directory = await apiRequest<Directory>(`/api/v1/conversations/${conversation.id}/secure`);
    if (!same(directory.accounts.map(a => a.account_id), conversation.members.map(m => m.id))) throw new MessagingAccessError("changed", "Состав беседы изменился. Обнови её перед отправкой");
    let waiting = false;
    for (const account of directory.accounts) {
      if (!account.ready || !account.public_key || !account.rosters.length) { waiting = true; continue; }
      const checked = await this.crypto.execute({ operation: "inspect_roster", public_key: account.public_key, roster: account.rosters.at(-1)! });
      if (checked.result.account_id !== account.account_id || checked.result.changed) throw new MessagingAccessError("changed", "Сверочный ключ участника изменился. Отправка остановлена");
      // Pin the first observed identity; later root changes still fail closed.
      // Out-of-band fingerprint comparison is available without blocking first contact.
      if (confirmed?.some(item => item.account_id === account.account_id && item.fingerprint !== checked.result.fingerprint)) throw new MessagingAccessError("changed", "Сверочный код изменился");
      const known = Number(checked.result.known_revision);
      const latest = Number(checked.result.revision);
      if (latest < known) throw new MessagingAccessError("changed", "Сервер вернул устаревший список устройств");
      for (const roster of account.rosters) {
        const revision = Number(JSON.parse(roster.payload).revision);
        if (revision > known || revision === latest) await this.crypto.execute({ operation: "accept_roster", public_key: account.public_key, roster, fingerprint: checked.result.pinned ? null : checked.result.fingerprint as string });
      }
    }
    const exported = await this.crypto.execute({ operation: "export_contact_pins" });
    const saved = await apiRequest<{ pins: ContactPin[] }>("/api/v1/security/contacts"); const pins = exported.result.pins as ContactPin[];
    if (pins.some(pin => !saved.pins.some(old => old.account_id === pin.account_id && old.public_key === pin.public_key))) await apiRequest("/api/v1/security/contacts", { method: "POST", body: JSON.stringify({ device_id: this.device!.device_id, pins }) });
    if (waiting) throw new MessagingAccessError("waiting", "Не все участники настроили ключи. Старую историю можно читать; новые сообщения будут защищёнными");
    return directory;
  }
  async verificationCodes(conversation: Conversation): Promise<KeyReview[]> {
    return this.lock(async () => {
      await this.ready();
      const directory = await this.checkDirectory(conversation);
      const codes: KeyReview[] = [];
      for (const account of directory.accounts) if (account.account_id !== this.account && account.public_key && account.rosters.length) {
        const inspected = await this.crypto.execute({ operation: "inspect_roster", public_key: account.public_key, roster: account.rosters.at(-1)! });
        codes.push({ account_id: account.account_id, fingerprint: inspected.result.fingerprint as string });
      }
      return codes;
    });
  }
  private payload(item: DeliveryItem): string {
    const transport = hint(item); if (!transport) throw new Error("Неполный пакет в очереди");
    const lease = transport.lease; const result = item.payload;
    const message: Packet | null = item.operation === "send" ? { context: result.context as MessageContext, epoch: result.epoch as number, wire: result.wire as string, body: result.body as Envelope, backups: result.backups as Record<string, HistoryBackup> } : null;
    return canonical({ version: 1, conversation_id: transport.conversation_id, group_id: lease.group_id, request_id: lease.request_id, lease_id: lease.lease_id, expected_sequence: lease.expected_sequence, operation: transport.migration ? "migrate" : lease.operation, source_files: transport.migration?.source_files ?? null, previous_epoch: lease.previous_epoch, roster: lease.roster, targets: lease.targets, package_ids: lease.packages.map(p => p.id), commit: message ? null : result.commit, welcome: message ? null : result.welcome, message, files: transport.files });
  }
  private async post(item: DeliveryItem): Promise<SecureEvent> {
    const transport = hint(item)!; const payload = this.payload(item);
    const signed = await this.crypto.execute({ operation: "sign_action", nonce: transport.lease.nonce, payload });
    const body = { device_id: this.device!.device_id, payload, proof: signed.result.proof };
    const prefix = `/api/v1/conversations/${transport.conversation_id}/secure`;
    if (!transport.files.length) {
      const event = await apiRequest<SecureEvent>(`${prefix}/publish`, { method: "POST", body: JSON.stringify(body) });
      this.acquired.delete(transport.lease.lease_id); return event;
    }
    const form = new FormData(); form.append("data", JSON.stringify(body));
    for (const file of transport.files) form.append("files", new File([await cachedCipher(this.account, file.id)], file.id, { type: "application/octet-stream" }));
    const event = await apiRequest<SecureEvent>(`${prefix}/files`, { method: "POST", body: form });
    this.acquired.delete(transport.lease.lease_id); return event;
  }
  private async cancel(item: DeliveryItem): Promise<{ accepted: boolean; event?: SecureEvent }> {
    const transport = hint(item)!;
    return this.cancelLease(transport.conversation_id, transport.lease);
  }
  private async cancelLease(conversationId: string, lease: Lease): Promise<{ accepted: boolean; event?: SecureEvent }> {
    const payload = canonical({ operation: "cancel", conversation_id: conversationId, lease_id: lease.lease_id, request_id: lease.request_id });
    const signed = await this.crypto.execute({ operation: "sign_action", nonce: lease.nonce, payload });
    return apiRequest(`/api/v1/conversations/${conversationId}/secure/cancel`, { method: "POST", body: JSON.stringify({ device_id: this.device!.device_id, nonce: lease.nonce, payload, proof: signed.result.proof }) });
  }
  private async resolveCandidates(conversation: Conversation): Promise<void> {
    for (const item of await this.crypto.pendingDeliveries()) {
      const transport = hint(item); if (transport?.conversation_id !== conversation.id) continue;
      const accepted = await apiRequest<{ accepted: boolean }>(`/api/v1/conversations/${conversation.id}/secure/operations/${transport.lease.request_id}?device_id=${this.device!.device_id}`);
      if (accepted.accepted) continue;
      try { await this.post(item); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const cancelled = await this.cancel(item); if (cancelled.accepted) continue;
        if (item.operation === "add_members" || item.operation === "remove_members") await this.crypto.execute({ operation: "discard_commit", conversation_id: transport.lease.group_id, commit: item.payload.commit as string }, item.id);
        else if (transport.migration) {
          // The original cloud row is untouched on rejection; a fresh attempt rereads it.
          await this.crypto.delivered(item.id);
          await forgetCipher(this.account, transport.files.map(file => file.id)).catch(() => {});
        }
        // An unaccepted application is kept and rebased only after synchronization.
      }
    }
  }
  private devices(directory: Directory): Map<string, DeviceBinding> {
    const result = new Map<string, DeviceBinding>();
    for (const account of directory.accounts) for (const device of JSON.parse(account.rosters.at(-1)!.payload).devices as DeviceBinding[]) result.set(device.device_id, device);
    return result;
  }
  private async pull(conversation: Conversation, directory: Directory): Promise<void> {
    const verified = this.devices(directory);
    for (;;) {
      const cursor = Number((await this.crypto.execute({ operation: "stream_cursor", stream: conversation.id })).result.sequence);
      const page = await apiRequest<{ events: SecureEvent[]; has_more: boolean }>(`/api/v1/conversations/${conversation.id}/secure/events?device_id=${this.device!.device_id}&after=${cursor}`);
      for (const event of page.events) {
        await this.crypto.execute({ operation: "verify_action", device: event.sender, nonce: event.nonce, payload: event.payload, proof: event.proof });
        const packet = JSON.parse(event.payload) as Operation;
        if (packet.version !== 1 || packet.conversation_id !== conversation.id || packet.request_id !== event.id || packet.expected_sequence + 1 !== event.sequence || new Set(packet.roster).size !== packet.roster.length || packet.roster.some(id => !verified.has(id)) || !packet.roster.includes(event.sender.device_id)) throw new MessagingAccessError("changed", "Нарушена последовательность защищённой беседы");
        const ours = packet.roster.includes(this.device!.device_id);
        let inner: CryptoCommand | null = null; let delivered: string | undefined;
        if (ours) {
          await this.crypto.execute({ operation: "authorize_conversation", conversation_id: packet.group_id, device_ids: packet.roster });
          const pending = (await this.crypto.pendingDeliveries()).find(item => hint(item)?.lease.request_id === event.id);
          if (event.sender.device_id === this.device!.device_id) {
            if (!pending || this.payload(pending) !== event.payload) throw new Error("Подтверждение не совпадает с локальной очередью");
            delivered = pending.id;
            if (!packet.message) inner = { operation: "acknowledge_commit", conversation_id: packet.group_id, commit: packet.commit! };
          } else if (!packet.message) {
            inner = packet.targets.includes(this.device!.device_id)
              ? { operation: "join", conversation_id: packet.group_id, welcome: packet.welcome! }
              : { operation: "receive", conversation_id: packet.group_id, message_id: null, wire: packet.commit!, body: null };
          } else {
            const message = packet.message!;
            inner = { operation: "receive", conversation_id: packet.group_id, message_id: message.context.message_id, wire: message.wire, body: message.body };
          }
        }
        await this.crypto.execute({ operation: "apply_event", stream: conversation.id, sequence: event.sequence, command: inner, expected_members: ours ? packet.roster : null, group_id: ours ? packet.group_id : null }, delivered);
        if (delivered && packet.files.length) await forgetCipher(this.account, packet.files.map(file => file.id)).catch(() => {});
      }
      if (!page.has_more) return;
    }
  }
  private async acquire(conversation: Conversation, operation: Lease["operation"]): Promise<Lease> {
    for (let attempt = 0; ; attempt++) {
      try {
        const lease = await apiRequest<Lease>(`/api/v1/conversations/${conversation.id}/secure/lease`, { method: "POST", body: JSON.stringify({ device_id: this.device!.device_id, request_id: crypto.randomUUID(), operation }) });
        this.acquired.set(lease.lease_id, { conversation, lease }); return lease;
      }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 409 || !error.message.includes("Другая отправка") || attempt >= 3) throw error; await pause(1100); }
    }
  }
  private async ensureGroup(conversation: Conversation, directory: Directory): Promise<void> {
    const desired = directory.eligible_devices; const state = directory.state;
    if (state.group_id && state.roster.includes(this.device!.device_id) && same(state.roster, desired)) return;
    const operation = !state.group_id ? "init" : !state.roster.includes(this.device!.device_id) ? "reset" : "add";
    const lease = await this.acquire(conversation, operation);
    await this.crypto.execute({ operation: "authorize_conversation", conversation_id: lease.group_id, device_ids: lease.roster });
    if (operation === "init" || operation === "reset") await this.crypto.execute({ operation: "create_group", conversation_id: lease.group_id });
    const result = await this.crypto.execute({ operation: "add_members", conversation_id: lease.group_id, key_packages: lease.packages.map(p => p.wire) }, undefined, { conversation_id: conversation.id, lease, files: [] });
    const item = (await this.crypto.pendingDeliveries()).find(p => p.id === result.delivery_id)!;
    await this.post(item);
    await this.pull(conversation, directory);
    directory.state = (await apiRequest<Directory>(`/api/v1/conversations/${conversation.id}/secure`)).state;
  }
  private async prepare(conversation: Conversation, confirmed?: KeyReview[]): Promise<Directory> {
    await this.ready();
    const directory = await this.checkDirectory(conversation, confirmed);
    await this.resolveCandidates(conversation);
    await this.pull(conversation, directory);
    directory.state = (await apiRequest<Directory>(`/api/v1/conversations/${conversation.id}/secure`)).state;
    await this.ensureGroup(conversation, directory);
    for (const old of await this.crypto.pendingDeliveries()) {
      if (old.operation !== "send" || hint(old)?.conversation_id !== conversation.id) continue;
      const result = old.payload; const context = result.context as MessageContext;
      const decrypted = await this.crypto.execute({ operation: "open_backup", context, body: result.body as Envelope, backup: (result.backups as Record<string, HistoryBackup>)[this.account] });
      const lease = await this.acquire(conversation, "message");
      await this.pull(conversation, directory);
      const next = await this.crypto.execute({ operation: "send", conversation_id: lease.group_id, message_id: context.message_id, content: decrypted.result.content as string, archive_accounts: directory.accounts.map(a => a.account_id) }, old.id, { conversation_id: conversation.id, lease, files: hint(old)!.files });
      await this.post((await this.crypto.pendingDeliveries()).find(p => p.id === next.delivery_id)!);
      await this.pull(conversation, directory);
    }
    return directory;
  }
  async synchronize(conversation: Conversation, confirmed?: KeyReview[]): Promise<void> { return this.lock(async () => { await this.prepare(conversation, confirmed); }); }
  async hasPending(messageId: string): Promise<boolean> { return (await this.crypto.pendingDeliveries()).some(item => item.operation === "send" && (item.payload.context as MessageContext)?.message_id === messageId); }
  async cancelPending(conversation: Conversation): Promise<void> {
    return this.lock(async () => {
      await this.ready();
      const directory = await this.checkDirectory(conversation);
      for (const item of await this.crypto.pendingDeliveries()) {
        if (hint(item)?.conversation_id !== conversation.id) continue;
        const result = await this.cancel(item); if (result.accepted) continue;
        if (item.operation === "add_members") await this.crypto.execute({ operation: "discard_commit", conversation_id: hint(item)!.lease.group_id, commit: item.payload.commit as string }, item.id);
        else await this.crypto.delivered(item.id);
        await forgetCipher(this.account, hint(item)!.files.map(f => f.id)).catch(() => {});
      }
      await this.pull(conversation, directory);
    });
  }
  async send(conversation: Conversation, body: string, files: File[], messageId: string): Promise<Message> {
    return this.lock(async () => {
      const directory = await this.prepare(conversation);
      try { return await this.decrypt(await apiRequest<Message>(`/api/v1/conversations/${conversation.id}/messages/${messageId}`)); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      const fileContext: MessageContext = { conversation_id: conversation.id, message_id: messageId, sender_account_id: this.account, sender_device_id: this.device!.device_id };
      const sealed = await sealFiles(this.crypto, this.account, fileContext, files);
      const lease = await this.acquire(conversation, "message");
      await this.pull(conversation, directory);
      const sent = await this.crypto.execute({ operation: "send", conversation_id: lease.group_id, message_id: messageId, content: canonical({ version: 1, body, files: sealed.metadata }), archive_accounts: directory.accounts.map(a => a.account_id) }, undefined, { conversation_id: conversation.id, lease, files: sealed.publicFiles });
      await this.post((await this.crypto.pendingDeliveries()).find(p => p.id === sent.delivery_id)!);
      await this.pull(conversation, directory);
      return this.decrypt(await apiRequest<Message>(`/api/v1/conversations/${conversation.id}/messages/${messageId}`));
    });
  }
  async migrateOwnHistory(conversation: Conversation, progress: (done: number, total: number) => void): Promise<void> {
    if (this.migrated.has(conversation.id)) return;
    const running = this.migrations.get(conversation.id); if (running) return running;
    const task = (async () => {
      const legacy: Message[] = []; let before: string | undefined;
      for (;;) {
        const page = await api.messages(conversation.id, before);
        legacy.push(...page.messages.filter(message => !message.crypto && message.sender_id === this.account));
        if (!page.has_more || !page.messages.length) break;
        before = page.messages[0].id;
      }
      let done = 0; progress(done, legacy.length);
      for (const old of legacy.reverse()) {
        await this.lock(async () => {
          const directory = await this.prepare(conversation);
          const current = await apiRequest<Message>(`/api/v1/conversations/${conversation.id}/messages/${old.id}`);
          if (current.crypto) return;
          const files: File[] = [];
          for (const attachment of current.attachments) {
            const source = await attachmentObjectUrl(`/api/v1/conversations/${conversation.id}/attachments/${attachment.id}`);
            try {
              const response = await fetch(source, { credentials: "include" });
              if (!response.ok) throw new Error("Вложение уже удалено. История будет перенесена при следующем открытии");
              files.push(new File([await response.blob()], attachment.filename, { type: attachment.media_type }));
            } finally { if (source.startsWith("blob:")) URL.revokeObjectURL(source); }
          }
          const context: MessageContext = { conversation_id: conversation.id, message_id: old.id, sender_account_id: this.account, sender_device_id: this.device!.device_id };
          const sealed = await sealFiles(this.crypto, this.account, context, files);
          const lease = await this.acquire(conversation, "message"); await this.pull(conversation, directory);
          const migration = { source_files: current.attachments.map(file => file.id) };
          const result = await this.crypto.execute({ operation: "send", conversation_id: lease.group_id, message_id: old.id, content: canonical({ version: 1, body: current.body, files: sealed.metadata }), archive_accounts: directory.accounts.map(account => account.account_id) }, undefined, { conversation_id: conversation.id, lease, files: sealed.publicFiles, migration });
          await this.post((await this.crypto.pendingDeliveries()).find(item => item.id === result.delivery_id)!);
          await this.pull(conversation, directory);
        });
        progress(++done, legacy.length); await pause(20);
      }
      this.migrated.add(conversation.id);
    })().finally(() => this.migrations.delete(conversation.id));
    this.migrations.set(conversation.id, task); return task;
  }
  async decrypt(message: Message): Promise<Message> {
    if (!message.crypto) return message;
    const secure = message.crypto as unknown as Omit<SecureEvent, "id" | "sequence" | "created_at">;
    const signature = canonical(secure); const cached = this.decoded.get(message.id);
    if (cached?.signature === signature) return { ...message, body: cached.message.body, attachments: message.attachments_expired ? [] : cached.message.attachments };
    await this.crypto.execute({ operation: "verify_action", device: secure.sender, nonce: secure.nonce, payload: secure.payload, proof: secure.proof });
    const operation = JSON.parse(secure.payload) as Operation; const packet = operation.message;
    if (!packet || operation.conversation_id !== message.conversation_id || packet.context.message_id !== message.id || packet.context.sender_account_id !== message.sender_id || packet.context.sender_account_id !== secure.sender.account_id || packet.context.sender_device_id !== secure.sender.device_id || packet.context.conversation_id !== operation.group_id) throw new Error("Защищённое сообщение не прошло проверку");
    const backup = packet.backups[this.account]; if (!backup) return { ...message, body: "Сообщение отправлено до твоего вступления в группу", attachments: [] };
    const opened = await this.crypto.execute({ operation: "open_backup", context: packet.context, body: packet.body, backup });
    const content = JSON.parse(opened.result.content as string) as { version: number; body: string; files: SecureFile[] };
    if (content.version !== 1 || typeof content.body !== "string" || content.body.length > 4000 || !Array.isArray(content.files) || content.files.length > 4) throw new Error("Неизвестный формат сообщения");
    const attachments = message.attachments_expired ? [] : content.files.map(meta => {
      const publicFile = operation.files.find(file => file.id === meta.id);
      if (!publicFile || meta.context.conversation_id !== message.conversation_id || meta.context.message_id !== message.id || meta.context.sender_account_id !== message.sender_id || meta.cipher_size !== publicFile.byte_size || meta.digest !== publicFile.digest) throw new Error("Данные вложения не прошли проверку");
      return { id: meta.id, filename: meta.name, media_type: meta.media_type, byte_size: meta.size, secure: meta };
    });
    const result: Message = { ...message, body: content.body, attachments };
    if (this.decoded.size >= 500) this.decoded.delete(this.decoded.keys().next().value!);
    this.decoded.set(message.id, { signature, message: result }); return result;
  }
  async openAttachment(path: string, attachment: SecureFile): Promise<string> { return openCipherFile(this.crypto, path, attachment); }
}

const instances = new Map<string, MlsMessaging>();
export function messagingFor(account: string): MlsMessaging { let value = instances.get(account); if (!value) { value = new MlsMessaging(account); instances.set(account, value); } return value; }
export function closeMessaging(account: string): void { instances.get(account)?.close(); instances.delete(account); }
