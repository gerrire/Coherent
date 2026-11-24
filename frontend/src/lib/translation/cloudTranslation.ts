import { apiRequest } from "../api";
import type { TranslationLanguage } from "./protocol";
import type { Caption } from "./transport";

export type TranslationMethod = "local" | "gigachat";

export interface GigaChatConfiguration {
  enabled: boolean;
  configured: boolean;
  model: string | null;
}

export async function getGigaChatConfiguration(callId: string, signal?: AbortSignal): Promise<GigaChatConfiguration> {
  return apiRequest<GigaChatConfiguration>(`/api/v1/calls/${encodeURIComponent(callId)}/translation/config`, { signal });
}

/** Only explicitly opted-in source captions may leave the encrypted call. */
export async function translateWithGigaChat(
  callId: string, caption: Caption, targetLanguage: TranslationLanguage, signal: AbortSignal,
): Promise<string> {
  if (caption.language === targetLanguage) return caption.text;
  if (caption.cloudAllowed !== true) throw new Error("Говорящий не разрешил отправку своих фраз в GigaChat.");
  if (signal.aborted) throw new DOMException("Перевод отменён", "AbortError");
  const result = await apiRequest<{ text: string }>(`/api/v1/calls/${encodeURIComponent(callId)}/translation`, {
    method: "POST", signal,
    body: JSON.stringify({
      text: caption.text, source_language: caption.language, target_language: targetLanguage,
      segment_id: caption.id, speaker_id: caption.speakerId,
    }),
  });
  if (signal.aborted) throw new DOMException("Перевод отменён", "AbortError");
  if (typeof result?.text !== "string" || !result.text.trim() || result.text.length > 600
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.text)) {
    throw new Error("GigaChat вернул неполную или некорректную фразу. Попробуй повторить перевод.");
  }
  return result.text.trim();
}
