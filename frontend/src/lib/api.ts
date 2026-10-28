import { invoke, isTauri } from "@tauri-apps/api/core";

export interface User {
  email?: string | null;
  email_verified?: boolean;
  email_delivery_available?: boolean;
  id: string;
  username: string;
  display_name?: string | null;
  created_at: string;
  is_admin: boolean;
}

export interface AdminOverview {
  chat_encryption_mode?: string;
  history_reset_at?: string | null;
  e2ee_storage_bytes: number;
  e2ee_storage_limit_bytes: number;
  pending_private_migration: number;
  backup: {last_success_at?: string; bytes?: number; offsite_last_success_at?: string; offsite_bytes?: number; restore_checked_at?: string} | null;
  cloud_encryption_enabled: boolean;
  legacy_plaintext_messages: number;
  legacy_plaintext_attachments: number;
  online_users: number;
  users: number;
  conversations: number;
  messages: number;
  active_calls: number;
  attachment_count: number;
  attachment_bytes: number;
  attachment_limit_bytes: number;
  disk_free_bytes: number;
  disk_total_bytes: number;
  recent_users: Array<{ username: string; created_at: string }>;
}

export interface ServerMetricSample {
  api_requests_minute?: number;
  api_errors_minute?: number;
  api_p95_ms?: number | null;
  network_receive_bps?: number;
  network_send_bps?: number;
  at: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  host_uptime_seconds: number | null;
  api_uptime_seconds: number;
  load_average: number[] | null;
  cpu_count: number | null;
}

export type RelationshipStatus =
  | "none"
  | "outgoing_pending"
  | "incoming_pending"
  | "friends";

export interface UserSearchResult {
  id: string;
  username: string;
  display_name?: string | null;
  relationship: RelationshipStatus;
  request_id: string | null;
}

export interface Friend {
  id: string;
  username: string;
  display_name?: string | null;
  since: string;
}

export interface FriendRequest {
  request_id: string;
  user_id: string;
  username: string;
  display_name?: string | null;
  created_at: string;
}

export interface FriendRequests {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface MessageReply {
  id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  attachment_count: number;
  attachments_expired: boolean;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  reply_to_id?: string | null;
  reply_to?: MessageReply | null;
  crypto?: Record<string, unknown> | null;
  locked?: boolean;
  body: string;
  attachment_count: number;
  attachments_expired: boolean;
  attachments: Array<{ id: string; filename: string; media_type: string; byte_size: number; secure?: import("./crypto/files").SecureFile }>;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
}

export interface Conversation {
  encryption?: "mls" | "cloud";
  server_id?: string | null;
  channel_id?: string | null;
  id: string;
  kind: "direct" | "group";
  owner_id?: string | null;
  name: string | null;
  members: Array<{ id: string; username: string; display_name?: string | null }>;
  other_user: { id: string; username: string; display_name?: string | null } | null;
  created_at: string;
  updated_at: string;
  last_message: Message | null;
  unread: boolean;
}

export interface CommunityServer {
  id: string;
  name: string;
  owner_id: string;
  member_count: number;
  channels: Array<{ id: string; conversation_id: string; name: string; category: string }>;
}

export function displayName(person: { username: string; display_name?: string | null }): string {
  return person.display_name?.trim() || person.username;
}

export function conversationTitle(conversation: Conversation): string {
  return conversation.kind === "group"
    ? conversation.name || "Групповой чат"
    : (conversation.other_user ? displayName(conversation.other_user) : "Личная беседа");
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
  has_newer?: boolean;
}

export interface Call {
  id: string;
  conversation_id: string;
  caller_id: string;
  caller_username: string;
  caller_display_name?: string | null;
  callee_id: string;
  callee_username: string;
  callee_display_name?: string | null;
  status: "ringing" | "active" | "declined" | "cancelled" | "ended" | "missed";
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  ended_at: string | null;
  participants: Array<{
    user_id: string;
    username: string;
  display_name?: string | null;
    state: "invited" | "joined" | "declined" | "left";
  }>;
}

export interface CallJoin {
  crypto_protocol?: "account_mls_v1" | "ephemeral_mls_v1";
  server_url: string;
  token: string;
  media_conversation_id: string;
}

interface AuthResponse {
  user: User;
}

interface ApiErrorBody {
  detail?: string | Array<{ msg?: string }>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

export async function currentCsrfToken(): Promise<string> {
  if (!csrfToken) await initializeCsrf();
  if (!csrfToken) throw new Error("Не удалось подтвердить запрос");
  return csrfToken;
}

export async function initializeCsrf(): Promise<void> {
  if (isTauri()) {
    await invoke("api_initialize_csrf");
    return;
  }
  const response = await fetch("/api/v1/auth/csrf", { credentials: "include" });
  if (!response.ok) {
    throw new ApiError("Не удалось подготовить защищённое соединение.", response.status);
  }
  const result: { csrf_token: string } = await response.json();
  csrfToken = result.csrf_token;
}

export interface DeviceSession {
  id: string; agent: string; current: boolean;
  created_at: string; last_seen_at: string; expires_at: string;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (isTauri()) {
    const reply = init.body instanceof FormData
      ? await invoke<{ status: number; body: unknown }>("api_upload", {
        path,
        body: String(init.body.get("body") ?? ""),
        secureData: init.body.has("data") ? String(init.body.get("data")) : null,
        replyToId: init.body.has("reply_to_id") ? String(init.body.get("reply_to_id")) : null,
        files: await Promise.all(init.body.getAll("files").filter((value): value is File => value instanceof File).map(async (file) => ({
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          data: await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
        }))),
      })
      : await invoke<{ status: number; body: unknown }>("api_request", {
        path, method, body: init.body ? JSON.parse(String(init.body)) : null,
      });
    if (reply.status === 204) return undefined as T;
    if (reply.status < 200 || reply.status >= 300) {
      if (reply.status === 401 && path !== "/api/v1/auth/login") window.dispatchEvent(new Event("coherent-session-ended"));
      const detail = (reply.body as ApiErrorBody)?.detail;
      const message = Array.isArray(detail) ? detail.map((item) => item.msg).join(". ") : detail;
      throw new ApiError(message || "Не получилось выполнить запрос. Попробуй ещё раз.", reply.status);
    }
    return reply.body as T;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && csrfToken === null) {
    await initializeCsrf();
  }

  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const signal = init.signal ?? AbortSignal.timeout(init.body instanceof FormData ? 120000 : 20000);
  const response = await fetch(path, { cache: "no-store", ...init, signal, method, headers, credentials: "include" });
  if (response.status === 204) return undefined as T;

  const result = await response.json().catch(() => ({} as ApiErrorBody));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/v1/auth/login") window.dispatchEvent(new Event("coherent-session-ended"));
    const detail = (result as ApiErrorBody).detail;
    const message = Array.isArray(detail) ? detail.map((item) => item.msg).join(". ") : detail;
    throw new ApiError(
      message || "Не получилось выполнить запрос. Попробуй ещё раз.",
      response.status,
    );
  }
  return result as T;
}

const request = apiRequest;

export async function attachmentObjectUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  const result = await invoke<{ media_type: string; data: string }>("api_attachment", { path });
  const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.media_type }));
}

export const api = {
  registrationCode: (email: string) => request<{ verification_id: string; expires_in_seconds: number; retry_after_seconds: number }>("/api/v1/auth/registration/code", { method: "POST", body: JSON.stringify({ email }) }),
  registrationDelivery: (id: string) => request<{ delivery: "pending" | "sent" | "failed" }>(`/api/v1/auth/registration/${id}`),
  securityStatus: () => request<{ setup_available: boolean; configured: boolean; recovery_confirmed: boolean; chat_encryption: string; history_revision?:string|null; roster_revision: number; devices: Array<{ id: string; label: string; platform: string; approved_at: string }> }>("/api/v1/security/status"),
  deviceChallenge: (purpose: "bootstrap" | "confirm_recovery" | "action", call_id?:string) => request<{ challenge_id: string; nonce: string }>("/api/v1/security/challenges", { method: "POST", body: JSON.stringify({ purpose,call_id:call_id??null }) }),
  recoveryMaterial: () => request<{ public_key: string; backup: import("./crypto/types").Envelope; rosters: import("./crypto/types").SignedRoster[] }>("/api/v1/security/recovery/material"),
  enrollDevice: (body: unknown) => request<{ approved: boolean; device_id: string; revision: number }>("/api/v1/security/devices/enroll", { method: "POST", body: JSON.stringify(body) }),
  bootstrapSecurity: (body: unknown) => request<{ configured: boolean }>("/api/v1/security/bootstrap", { method: "POST", body: JSON.stringify(body) }),
  confirmRecoverySaved: (body: unknown) => request<{ confirmed: boolean }>("/api/v1/security/recovery/confirm", { method: "POST", body: JSON.stringify(body) }),
  servers: () => request<CommunityServer[]>("/api/v1/servers"),
  createServer: (name: string) => request<CommunityServer>("/api/v1/servers", { method: "POST", body: JSON.stringify({ name }) }),
  joinServer: (code: string) => request<CommunityServer>("/api/v1/servers/join", { method: "POST", body: JSON.stringify({ code }) }),
  createServerChannel: (id: string, name: string, category: string) => request<CommunityServer>(`/api/v1/servers/${id}/channels`, { method: "POST", body: JSON.stringify({ name, category }) }),
  createServerInvite: (id: string) => request<{ code: string; expires_at: string; max_uses: number }>(`/api/v1/servers/${id}/invites`, { method: "POST" }),
  serverConversation: (serverId: string, channelId: string) => request<Conversation>(`/api/v1/servers/${serverId}/channels/${channelId}/conversation`),
  me: () => request<User>("/api/v1/auth/me"),
  register: (payload: { username: string; password: string; email: string; verification_id: string; code: string }) =>
    request<AuthResponse>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  login: (payload: { username: string; password: string }) =>
    request<AuthResponse>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  logout: () => request<void>("/api/v1/auth/logout", { method: "POST" }),
  sessions: () => request<{ sessions: DeviceSession[] }>("/api/v1/auth/sessions"),
  terminateSession: (id: string) => request<void>(`/api/v1/auth/sessions/${id}`, { method: "DELETE" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/v1/auth/password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),
  updateProfile: (display_name: string) => request<User>("/api/v1/auth/profile", { method: "PATCH", body: JSON.stringify({ display_name }) }),
  requestEmailCode: (email: string, current_password: string) => request<{ expires_in_seconds: number; retry_after_seconds: number }>("/api/v1/auth/email/code", { method: "POST", body: JSON.stringify({ email, current_password }) }),
  confirmEmailCode: (code: string) => request<User>("/api/v1/auth/email/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  adminOverview: () => request<AdminOverview>("/api/v1/admin/overview"),
  adminMetrics: () => request<{ samples: ServerMetricSample[]; interval_seconds: number }>("/api/v1/admin/metrics"),
  pushKey: () => request<{ public_key: string }>("/api/v1/push/key"),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<void>("/api/v1/push/subscriptions", { method: "POST", body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint: string) =>
    request<void>("/api/v1/push/subscriptions/remove", { method: "POST", body: JSON.stringify({ endpoint }) }),
  searchUsers: (query: string) =>
    request<UserSearchResult[]>(`/api/v1/users/search?query=${encodeURIComponent(query)}`),
  relationship: (userId: string) =>
    request<UserSearchResult>(`/api/v1/users/${userId}/relationship`),
  friends: () => request<{ friends: Friend[] }>("/api/v1/friends"),
  presence: () => request<{ online_user_ids: string[] }>("/api/v1/users/presence"),
  friendRequests: () => request<FriendRequests>("/api/v1/friends/requests"),
  sendFriendRequest: (targetUserId: string) =>
    request<{ request_id: string; status: "pending" | "accepted" }>(
      "/api/v1/friends/requests",
      { method: "POST", body: JSON.stringify({ target_user_id: targetUserId }) },
    ),
  acceptFriendRequest: (requestId: string) =>
    request<{ request_id: string; status: "accepted" }>(
      `/api/v1/friends/requests/${requestId}/accept`,
      { method: "POST" },
    ),
  removeFriendRequest: (requestId: string) =>
    request<void>(`/api/v1/friends/requests/${requestId}`, { method: "DELETE" }),
  conversations: async () => {
    const collected = new Map<string, Conversation>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { conversations: Conversation[]; next_cursor?: string | null } = await request(`/api/v1/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const conversation of page.conversations) collected.set(conversation.id, conversation);
      cursor = page.next_cursor || null;
      if (cursor && seen.has(cursor)) throw new Error("Список бесед изменился. Повтори загрузку");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { conversations: [...collected.values()] };
  },
  openConversation: (userId: string) =>
    request<Conversation>("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    }),
  addGroupMembers: (id: string, userIds: string[]) => request<Conversation>(`/api/v1/conversations/${id}/members`, { method: "POST", body: JSON.stringify({ user_ids: userIds }) }),
  removeGroupMember: (id: string, userId: string) => request<void>(`/api/v1/conversations/${id}/members/${userId}`, { method: "DELETE" }),
  serverMembers: (id: string) => request<{members: Array<{id:string; username:string; display_name:string|null; role:"owner"|"moderator"|"member"}>}>(`/api/v1/servers/${id}/members`),
  editServer: (id: string, name: string) => request<CommunityServer>(`/api/v1/servers/${id}`, { method:"PATCH", body:JSON.stringify({name}) }),
  editServerChannel: (id:string, channel:string, name:string, category:string) => request<CommunityServer>(`/api/v1/servers/${id}/channels/${channel}`, {method:"PATCH",body:JSON.stringify({name,category})}),
  deleteServerChannel: (id:string, channel:string) => request<CommunityServer>(`/api/v1/servers/${id}/channels/${channel}`, {method:"DELETE"}),
  removeServerMember: (id:string, member:string) => request<void>(`/api/v1/servers/${id}/members/${member}`, {method:"DELETE"}),
  setServerRole: (id:string, member:string, role:string) => request<void>(`/api/v1/servers/${id}/members/${member}`, {method:"PATCH",body:JSON.stringify({role})}),
  transferServer: (id:string, userId:string) => request<CommunityServer>(`/api/v1/servers/${id}/owner`, {method:"POST",body:JSON.stringify({user_id:userId})}),
  deleteServer: (id:string) => request<void>(`/api/v1/servers/${id}`, {method:"DELETE"}),
  createGroup: (userIds: string[], name?: string) =>
    request<Conversation>("/api/v1/conversations/groups", {
      method: "POST",
      body: JSON.stringify({ user_ids: userIds, name }),
    }),
  renameGroup: (conversationId: string, name: string) =>
    request<Conversation>(`/api/v1/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  messages: (conversationId: string, before?: string) =>
    request<MessagePage>(
      `/api/v1/conversations/${conversationId}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  messagesAround: (conversationId: string, messageId: string) =>
    request<MessagePage>(`/api/v1/conversations/${conversationId}/messages?around=${encodeURIComponent(messageId)}`),
  markConversationRead: (conversationId: string, messageId: string) =>
    request<void>(`/api/v1/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId }),
    }),
  sendMessage: (conversationId: string, body: string, replyToId?: string) =>
    request<Message>(`/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, ...(replyToId ? { reply_to_id: replyToId } : {}) }),
    }),
  editMessage: (conversationId: string, messageId: string, body: string) =>
    request<Message>(`/api/v1/conversations/${conversationId}/messages/${messageId}`, {
      method: "PATCH", body: JSON.stringify({ body }),
    }),
  deleteMessage: (conversationId: string, messageId: string) =>
    request<Message>(`/api/v1/conversations/${conversationId}/messages/${messageId}`, { method: "DELETE" }),
  sendAttachments: (conversationId: string, body: string, files: File[], replyToId?: string) => {
    const data = new FormData();
    data.append("body", body);
    if (replyToId) data.append("reply_to_id", replyToId);
    files.forEach((file) => data.append("files", file));
    return request<Message>(`/api/v1/conversations/${conversationId}/messages/attachments`, {
      method: "POST", body: data,
    });
  },
  currentCalls: () => request<{ calls: Call[] }>("/api/v1/calls/current"),
  startCall: (conversationId: string) =>
    request<Call>(`/api/v1/conversations/${conversationId}/calls`, {
      method: "POST",
    }),
  inviteCall: (callId: string, userIds: string[]) =>
    request<Call>(`/api/v1/calls/${callId}/invite`, {
      method: "POST",
      body: JSON.stringify({ user_ids: userIds }),
    }),
  acceptCall: (callId: string) =>
    request<Call>(`/api/v1/calls/${callId}/accept`, { method: "POST" }),
  endCall: (callId: string) =>
    request<Call>(`/api/v1/calls/${callId}/end`, { method: "POST" }),
  endCallOnPageHide: (callId: string) => {
    if (isTauri()) return;
    if (!csrfToken) return;
    void fetch(`/api/v1/calls/${callId}/end`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "X-CSRF-Token": csrfToken },
    });
  },
  callCrypto: (id: string) => request<Conversation>(`/api/v1/calls/${id}/crypto`),
  joinCall: (callId: string) =>
    request<CallJoin>(`/api/v1/calls/${callId}/join`, { method: "POST" }),
};
