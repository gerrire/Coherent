import type { TranslationLanguage } from "./protocol";

/** Immutable, single-speaker Piper voices. Weights are fetched by browsers only. */
export const PIPER_VOICE_REVISION = "2f358b6a560e3a913ebf509b2f3344f20b367f94";
const ROOT = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICE_REVISION}`;
export const PIPER_VOICES: Record<TranslationLanguage, { label: string; modelUrl: string; espeak: string; license: string; cardUrl: string }> = {
  ru: voice("Denis · русский", "ru/ru_RU/denis", "ru_RU-denis-medium", "ru", "CC0"),
  en: voice("Joe · английский", "en/en_US/joe", "en_US-joe-medium", "en-us", "CC0"),
  de: voice("Thorsten · немецкий", "de/de_DE/thorsten", "de_DE-thorsten-medium", "de", "CC0"),
  fr: voice("Siwis · французский", "fr/fr_FR/siwis", "fr_FR-siwis-medium", "fr", "CC-BY-4.0"),
  es: voice("DaveFX · испанский", "es/es_ES/davefx", "es_ES-davefx-medium", "es", "CC0"),
};

function voice(label: string, directory: string, filename: string, espeak: string, license: string) {
  return {
    label, modelUrl: `${ROOT}/${directory}/medium/${filename}.onnx`, espeak, license,
    cardUrl: `https://huggingface.co/rhasspy/piper-voices/blob/${PIPER_VOICE_REVISION}/${directory}/medium/MODEL_CARD`,
  };
}
