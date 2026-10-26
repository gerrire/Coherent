/** Only fixed public categories cross the crypto boundary. Never forward raw errors. */
export class CryptoOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function publicCryptoError(reason: unknown): {code: string; message: string} {
  const name = reason instanceof Error ? reason.name : "";
  const message = reason instanceof Error ? reason.message : "";
  if (message === "MLS_WELCOME_TREE_MISSING") return {code:"WELCOME_TREE_MISSING",message:"Приглашение создано старой версией. Восстанавливаем защищённое подключение."};
  if (name === "QuotaExceededError") return {code:"STORAGE_FULL",message:"В браузере не хватает места для ключей. Освободи место, сохранив доступ к доверенному устройству."};
  if (["SecurityError", "InvalidStateError", "DataCloneError", "NotSupportedError"].includes(name)) return {code:"STORAGE_UNAVAILABLE",message:"Браузер запретил защищённое хранилище. Разреши данные сайта или используй отдельный обычный профиль браузера."};
  if (message === "The device identity is not pinned for this conversation") return {code:"UNTRUSTED_DEVICE",message:"Не удалось проверить ключи участников. Обнови подключение; если ключ изменился, сверь его с собеседником."};
  if (message === "The authenticated encrypted object could not be opened") return {code:"INTEGRITY",message:"Защищённые данные не прошли проверку. Отправка остановлена; ключи и история сохранены."};
  if (message === "Local cryptographic state is unavailable") return {code:"LOCAL_STATE",message:"Локальная сессия ещё не готова. Повтори подключение. Код: E2EE_STATE."};
  if (message === "MLS rejected this operation") return {code:"MLS_OPERATION",message:"Не удалось синхронизировать защищённую сессию. Повтори подключение. Код: E2EE_MLS."};
  return {code:"CRYPTO_UNAVAILABLE",message:"Не удалось открыть защищённую переписку. Проверь соединение и повтори. Код: E2EE_CLIENT."};
}
