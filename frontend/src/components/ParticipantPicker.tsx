import { useEffect, useState, type FormEvent } from "react";
import { Search, UserPlus, UsersRound, X } from "lucide-react";
import { api, type Friend, type UserSearchResult } from "../lib/api";

interface ParticipantPickerProps {
  title: string;
  submitLabel?: string;
  excludedIds: string[];
  maxSelect: number;
  onSubmit: (userIds: string[]) => Promise<void>;
  onClose: () => void;
}

export default function ParticipantPicker({
  title,
  submitLabel = "Пригласить",
  excludedIds,
  maxSelect,
  onSubmit,
  onClose,
}: ParticipantPickerProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.friends().then((result) => {
      if (active) setFriends(result.friends);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      api.searchUsers(query.trim()).then((items) => {
        if (active) setResults(items);
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Поиск не удался.");
      });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const users = new Map<string, string>();
  if (query.trim().length < 2) {
    for (const friend of friends) users.set(friend.id, friend.username);
  } else {
    for (const result of results) users.set(result.id, result.username);
    for (const friend of friends) {
      if (friend.username.toLowerCase().includes(query.trim().toLowerCase())) {
        users.set(friend.id, friend.username);
      }
    }
  }
  for (const id of excludedIds) users.delete(id);

  function toggle(id: string) {
    setSelected((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length < maxSelect ? [...current, id] : current);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected.length || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось пригласить участников.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="participant-picker-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="participant-picker" onSubmit={(event) => void submit(event)} role="dialog" aria-modal="true" aria-label={title}>
        <div className="participant-picker-heading">
          <div><UsersRound size={20} /><strong>{title}</strong></div>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
        </div>
        <p>Выбери людей из друзей или найди их по имени. Можно пригласить до {maxSelect}.</p>
        <label className="participant-picker-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти пользователя" autoFocus />
        </label>
        <div className="participant-picker-list">
          {[...users].map(([id, username]) => (
            <label className="participant-picker-user" key={id}>
              <span className="avatar avatar-user">{username.slice(0, 1).toUpperCase()}</span>
              <strong>{username}</strong>
              <input type="checkbox" checked={selected.includes(id)} disabled={!selected.includes(id) && selected.length >= maxSelect} onChange={() => toggle(id)} />
            </label>
          ))}
          {users.size === 0 && <span className="participant-picker-empty">{query.trim().length < 2 ? "Введи имя или добавь друзей." : "Никого не нашли."}</span>}
        </div>
        {error && <p className="participant-picker-error" role="alert">{error}</p>}
        <div className="participant-picker-footer">
          <span>Выбрано: {selected.length} из {maxSelect}</span>
          <button className="primary-button" type="submit" disabled={busy || selected.length === 0}>
            <UserPlus size={16} /> {busy ? "Подождите..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
