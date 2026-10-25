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

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  attachment_count: number;
  attachments_expired: boolean;
  attachments: Array<{ id: string; filename: string; media_type: string; byte_size: number }>;
  created_at: string;
}

export interface Conversation {
  server_id?: string | null;
  channel_id?: string | null;
  id: string;
  kind: "direct" | "group";
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
  server_url: string;
  token: string;
  e2ee_key: string;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (isTauri()) {
    const reply = init.body instanceof FormData
      ? await invoke<{ status: number; body: unknown }>("api_upload", {
        path,
        body: String(init.body.get("body") ?? ""),
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

  const response = await fetch(path, { ...init, method, headers, credentials: "include" });
  if (response.status === 204) return undefined as T;

  const result = await response.json().catch(() => ({} as ApiErrorBody));
  if (!response.ok) {
    const detail = (result as ApiErrorBody).detail;
    const message = Array.isArray(detail) ? detail.map((item) => item.msg).join(". ") : detail;
    throw new ApiError(
      message || "Не получилось выполнить запрос. Попробуй ещё раз.",
      response.status,
    );
  }
  return result as T;
}

export async function attachmentObjectUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  const result = await invoke<{ media_type: string; data: string }>("api_attachment", { path });
  const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.media_type }));
}

export const api = {
  servers: () => request<CommunityServer[]>("/api/v1/servers"),
  createServer: (name: string) => request<CommunityServer>("/api/v1/servers", { method: "POST", body: JSON.stringify({ name }) }),
  joinServer: (code: string) => request<CommunityServer>("/api/v1/servers/join", { method: "POST", body: JSON.stringify({ code }) }),
  createServerChannel: (id: string, name: string, category: string) => request<CommunityServer>(`/api/v1/servers/${id}/channels`, { method: "POST", body: JSON.stringify({ name, category }) }),
  createServerInvite: (id: string) => request<{ code: string; expires_at: string; max_uses: number }>(`/api/v1/servers/${id}/invites`, { method: "POST" }),
  serverConversation: (serverId: string, channelId: string) => request<Conversation>(`/api/v1/servers/${serverId}/channels/${channelId}/conversation`),
  me: () => request<User>("/api/v1/auth/me"),
  register: (payload: { username: string; password: string }) =>
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
  conversations: () =>
    request<{ conversations: Conversation[] }>("/api/v1/conversations"),
  openConversation: (userId: string) =>
    request<Conversation>("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    }),
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
  markConversationRead: (conversationId: string, messageId: string) =>
    request<void>(`/api/v1/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId }),
    }),
  sendMessage: (conversationId: string, body: string) =>
    request<Message>(`/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  sendAttachments: (conversationId: string, body: string, files: File[]) => {
    const data = new FormData();
    data.append("body", body);
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
  joinCall: (callId: string) =>
    request<CallJoin>(`/api/v1/calls/${callId}/join`, { method: "POST" }),
};
