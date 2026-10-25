import { useEffect, useState, type FormEvent } from "react";
import { Check, Clock3, MessageCircle, Search, UserPlus, UsersRound, X } from "lucide-react";
import { api, displayName, type Friend, type FriendRequest, type UserSearchResult } from "../lib/api";

type Tab = "search" | "all" | "requests";

export default function FriendsPanel({
  onStartConversation,
  initialTab = "search",
  onlineIds,
  requestVersion,
}: {
  onStartConversation: (userId: string) => Promise<void>;
  initialTab?: Tab;
  onlineIds: Set<string>;
  requestVersion: number;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>({
    incoming: [],
    outgoing: [],
  });
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setTab(initialTab), [initialTab]);

  async function refreshOverview() {
    const [friendResult, requestResult] = await Promise.all([
      api.friends(),
      api.friendRequests(),
    ]);
    setFriends(friendResult.friends);
    setRequests(requestResult);
  }

  async function refreshSearch() {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return;
    const nextResults = await api.searchUsers(normalizedQuery);
    setResults(nextResults);
    setSearched(true);
  }

  useEffect(() => {
    refreshOverview().catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить друзей.");
    });
    if (query.trim().length >= 2) void refreshSearch().catch(() => undefined);
  }, [requestVersion]);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setError("Введи не менее двух символов имени пользователя.");
      return;
    }
    setError("");
    setSearched(false);
    setLoading(true);
    try {
      await refreshSearch();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Поиск не удался.");
    } finally {
      setLoading(false);
    }
  }

  async function sendOrAccept(user: UserSearchResult) {
    if (user.relationship === "friends" || user.relationship === "outgoing_pending") return;
    setBusyId(user.id);
    setError("");
    try {
      if (user.relationship === "incoming_pending" && user.request_id) {
        await api.acceptFriendRequest(user.request_id);
      } else {
        await api.sendFriendRequest(user.id);
      }
      await Promise.all([refreshOverview(), refreshSearch()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось обновить заявку.");
    } finally {
      setBusyId(null);
    }
  }

  async function acceptRequest(requestId: string) {
    setBusyId(requestId);
    setError("");
    try {
      await api.acceptFriendRequest(requestId);
      await refreshOverview();
      await refreshSearch();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось принять заявку.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeRequest(requestId: string) {
    setBusyId(requestId);
    setError("");
    try {
      await api.removeFriendRequest(requestId);
      await refreshOverview();
      await refreshSearch();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось удалить заявку.");
    } finally {
      setBusyId(null);
    }
  }

  async function startConversation(userId: string) {
    setBusyId(userId);
    setError("");
    try {
      await onStartConversation(userId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось открыть беседу.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="friends-panel">
      <div className="friends-heading">
        <div>
          <div className="friends-eyebrow"><UsersRound size={14} /> ТВОИ ЛЮДИ</div>
          <h1>Друзья</h1>
          <p>Находи людей, общайся и собирай свою компанию в Coherent.</p>
        </div>
        <div className="friends-heading-glow"><UsersRound size={28} /></div>
      </div>

      <div className="friends-tabs" role="tablist" aria-label="Разделы друзей">
        <button
          className={tab === "search" ? "active" : ""}
          role="tab"
          aria-selected={tab === "search"}
          onClick={() => setTab("search")}
        >
          <Search size={15} /> Поиск
        </button>
        <button
          className={tab === "all" ? "active" : ""}
          role="tab"
          aria-selected={tab === "all"}
          onClick={() => setTab("all")}
        >
          <UsersRound size={15} /> Все друзья
          <span className="tab-count">{friends.length}</span>
        </button>
        <button
          className={tab === "requests" ? "active" : ""}
          role="tab"
          aria-selected={tab === "requests"}
          onClick={() => setTab("requests")}
        >
          <UserPlus size={15} /> Заявки
          {requests.incoming.length > 0 && (
            <span className="tab-count tab-count-alert">{requests.incoming.length}</span>
          )}
        </button>
      </div>

      {error && <div className="friends-error" role="alert">{error}</div>}

      {tab === "search" && (
        <section className="friends-section" aria-label="Поиск пользователей">
          <form className="friend-search-form" onSubmit={submitSearch}>
            <div className="friend-search-input">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Введи имя пользователя"
                minLength={2}
                maxLength={32}
                aria-label="Имя пользователя для поиска"
              />
              <span className="search-hint">минимум 2 символа</span>
            </div>
            <button className="primary-button friend-search-button" type="submit" disabled={loading}>
              {loading ? "Ищем..." : "Найти"}
            </button>
          </form>

          {!searched && !loading && (
            <div className="friends-empty-state">
              <div className="friends-empty-icon"><Search size={22} /></div>
              <strong>Кого будем искать?</strong>
              <span>Введи имя пользователя — мы покажем подходящие аккаунты.</span>
            </div>
          )}

          {searched && !loading && results.length === 0 && (
            <div className="friends-empty-state compact-empty">
              <div className="friends-empty-icon"><Search size={20} /></div>
              <strong>Пока никого не нашли</strong>
              <span>Проверь имя или попробуй другой вариант.</span>
            </div>
          )}

          {results.length > 0 && (
            <div className="friend-results">
              <div className="friend-list-caption">РЕЗУЛЬТАТЫ ПОИСКА <span>{results.length}</span></div>
              {results.map((result) => (
                <UserResultRow
                  key={result.id}
                  user={result}
                  busy={busyId === result.id}
                  onAction={() => sendOrAccept(result)}
                  onMessage={() => startConversation(result.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "all" && (
        <section className="friends-section" aria-label="Список друзей">
          <div className="friend-list-caption">ТВОЯ КОМПАНИЯ <span>{friends.length}</span></div>
          {friends.length === 0 ? (
            <div className="friends-empty-state compact-empty">
              <div className="friends-empty-icon"><UsersRound size={20} /></div>
              <strong>Здесь пока пусто</strong>
              <span>Найди пользователя и отправь ему заявку в друзья.</span>
              <button className="text-button" onClick={() => setTab("search")}>Перейти к поиску →</button>
            </div>
          ) : (
            <div className="friend-results">
              {friends.map((friend) => (
                <FriendRow
                  key={friend.id}
                  username={displayName(friend)}
                  online={onlineIds.has(friend.id)}
                  busy={busyId === friend.id}
                  onMessage={() => startConversation(friend.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "requests" && (
        <section className="friends-section" aria-label="Заявки в друзья">
          <div className="friend-list-caption">ВХОДЯЩИЕ <span>{requests.incoming.length}</span></div>
          {requests.incoming.length === 0 ? (
            <div className="request-empty">Новых заявок пока нет.</div>
          ) : (
            <div className="friend-results">
              {requests.incoming.map((request) => (
                <div className="friend-row request-row" key={request.request_id}>
                  <UserIdentity username={displayName(request)} />
                  <span className="request-date">{formatDate(request.created_at)}</span>
                  <div className="friend-row-actions">
                    <button
                      className="small-action accept-action"
                      disabled={busyId === request.request_id}
                      onClick={() => acceptRequest(request.request_id)}
                    >
                      <Check size={14} /> Принять
                    </button>
                    <button
                      className="icon-action decline-action"
                      aria-label={`Отклонить заявку от ${displayName(request)}`}
                      disabled={busyId === request.request_id}
                      onClick={() => removeRequest(request.request_id)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="friend-list-caption outgoing-caption">
            ИСХОДЯЩИЕ <span>{requests.outgoing.length}</span>
          </div>
          {requests.outgoing.length === 0 ? (
            <div className="request-empty">Ты ещё никому не отправлял заявку.</div>
          ) : (
            <div className="friend-results">
              {requests.outgoing.map((request) => (
                <div className="friend-row request-row" key={request.request_id}>
                  <UserIdentity username={displayName(request)} />
                  <span className="request-date">{formatDate(request.created_at)}</span>
                  <button
                    className="small-action pending-action"
                    disabled={busyId === request.request_id}
                    onClick={() => removeRequest(request.request_id)}
                  >
                    <Clock3 size={14} /> Отменить
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function UserResultRow({
  user,
  busy,
  onAction,
  onMessage,
}: {
  user: UserSearchResult;
  busy: boolean;
  onAction: () => void;
  onMessage: () => void;
}) {
  const actionLabel = user.relationship === "incoming_pending"
    ? "Принять"
    : user.relationship === "outgoing_pending"
      ? "Заявка отправлена"
      : user.relationship === "friends"
        ? "Уже друзья"
        : "Добавить";
  const canAct = user.relationship === "none" || user.relationship === "incoming_pending";

  return (
    <div className="friend-row">
      <UserIdentity username={displayName(user)} />
      <span className="friend-row-status">
        {user.relationship === "incoming_pending"
          ? "Отправил тебе заявку"
          : user.relationship === "outgoing_pending"
            ? "Ждёт ответа"
            : user.relationship === "friends"
              ? "Вы друзья"
              : "Новый пользователь"}
      </span>
      <div className="friend-row-actions">
        <button className="small-action message-action" disabled={busy} onClick={onMessage}>
          <MessageCircle size={14} /> Написать
        </button>
        <button
          className={`small-action ${canAct ? "add-action" : "pending-action"}`}
          disabled={!canAct || busy}
          onClick={onAction}
        >
          {user.relationship === "friends"
            ? <Check size={14} />
            : user.relationship === "outgoing_pending"
              ? <Clock3 size={14} />
              : <UserPlus size={14} />}
          {busy ? "Секунду..." : actionLabel}
        </button>
      </div>
    </div>
  );
}

function FriendRow({ username, online, busy, onMessage }: {
  username: string;
  online: boolean;
  busy: boolean;
  onMessage: () => void;
}) {
  return (
    <div className="friend-row">
      <UserIdentity username={username} />
      <span className={`friend-row-status ${online ? "friend-online" : "friend-offline"}`}><i />{online ? "В сети" : "Не в сети"}</span>
      <button className="small-action message-action" disabled={busy} onClick={onMessage}>
        <MessageCircle size={14} /> Написать
      </button>
    </div>
  );
}

function UserIdentity({ username }: { username: string }) {
  const initial = username.slice(0, 1).toUpperCase();
  return (
    <div className="friend-identity">
      <span className="friend-avatar">{initial}</span>
      <span className="friend-username">{username}</span>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}
