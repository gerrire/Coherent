const key = (accountId: string) => `coherent.update-location.${accountId}`;
const lifetime = 15 * 60 * 1000;

// Store only the conversation ID, never message text, attachments or call state.
export function rememberUpdateConversation(accountId: string, conversationId: string | null) {
  try {
    if (conversationId) localStorage.setItem(key(accountId), JSON.stringify({ conversationId, savedAt: Date.now() }));
    else clearUpdateConversation(accountId);
  } catch { /* Updating remains available when local storage is unavailable. */ }
}

export function readUpdateConversation(accountId: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key(accountId)) ?? "null");
    const age = Date.now() - saved?.savedAt;
    return typeof saved?.conversationId === "string" && saved.conversationId.length <= 128
      && age >= 0 && age < lifetime ? saved.conversationId : null;
  } catch { return null; }
}

export function clearUpdateConversation(accountId: string) {
  try { localStorage.removeItem(key(accountId)); } catch { /* Best effort. */ }
}
