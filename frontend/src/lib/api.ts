export interface User {
  id: string;
  username: string;
  created_at: string;
}

export type RelationshipStatus =
  | "none"
  | "outgoing_pending"
  | "incoming_pending"
  | "friends";

export interface UserSearchResult {
  id: string;
  username: string;
  relationship: RelationshipStatus;
  request_id: string | null;
}

export interface Friend {
  id: string;
  username: string;
  since: string;
}

export interface FriendRequest {
  request_id: string;
  user_id: string;
  username: string;
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
  created_at: string;
}

export interface Conversation {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  members: Array<{ id: string; username: string }>;
  other_user: { id: string; username: string } | null;
  created_at: string;
  updated_at: string;
  last_message: Message | null;
}

export function conversationTitle(conversation: Conversation): string {
  return conversation.kind === "group"
    ? conversation.name || "Групповой чат"
    : conversation.other_user?.username || "Личная беседа";
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
  callee_id: string;
  callee_username: string;
  status: "ringing" | "active" | "declined" | "cancelled" | "ended" | "missed";
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  ended_at: string | null;
  participants: Array<{
    user_id: string;
    username: string;
    state: "invited" | "joined" | "declined" | "left";
  }>;
}

export interface CallJoin {
  server_url: string;
  token: string;
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
  const response = await fetch("/api/v1/auth/csrf", { credentials: "include" });
  if (!response.ok) {
    throw new ApiError("Не удалось подготовить защищённое соединение.", response.status);
  }
  const result: { csrf_token: string } = await response.json();
  csrfToken = result.csrf_token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && csrfToken === null) {
    await initializeCsrf();
  }

  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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

export const api = {
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
  sendMessage: (conversationId: string, body: string) =>
    request<Message>(`/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
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
