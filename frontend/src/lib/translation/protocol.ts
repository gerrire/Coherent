/** All inference is local. Captions preserve the speaker's original language. */
import type { TranslationModelId } from "./models";

export type TranslationLanguage = "en" | "ru" | "de" | "fr" | "es";
export type TranslationQuality = "light" | "balanced";

export const TRANSLATION_LANGUAGES: ReadonlyArray<{ code: TranslationLanguage; label: string }> = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
];

export type TranslationWorkerRequest =
  | {
      id: number;
      type: "init";
      recognize: boolean;
      sourceLanguage: TranslationLanguage;
      targetLanguage: TranslationLanguage;
      quality?: TranslationQuality;
      model?: TranslationModelId;
    }
  | { id: number; type: "recognize"; audio: Float32Array; sourceLanguage?: TranslationLanguage }
  | { id: number; type: "translate"; text: string; sourceLanguage: TranslationLanguage };

export interface TranslationWorkerResponse {
  id: number;
  type: "ready" | "result" | "error" | "progress";
  text?: string;
  message?: string;
  /** Download progress for the current file, from 0 to 100. */
  progress?: number;
  stage?: "loading" | "inference";
}

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return TRANSLATION_LANGUAGES.some(({ code }) => code === value);
}
