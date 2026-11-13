/** Multilingual q8 Whisper models, downloaded only by the participant's browser. */
export type TranslationModelId = "tiny" | "base" | "small";
export type TranslationModelChoice = "auto" | TranslationModelId;

export interface TranslationModelProfile {
  id: TranslationModelId;
  label: string;
  description: string;
  hardwareHint: string;
  repository: string;
  revision: string;
  /** Sum of the q8 encoder and merged decoder file sizes, not resident RAM. */
  weightBytes: number;
}

// Sizes and immutable revisions are from the model repositories' file metadata.
// Tokenizer/config files and the shared WASM runtime are additional downloads.
export const TRANSLATION_MODELS: readonly TranslationModelProfile[] = [
  {
    id: "tiny", label: "Whisper Tiny", description: "Меньше нагрузка, больше ошибок распознавания",
    hardwareHint: "Для слабых устройств", repository: "Xenova/whisper-tiny",
    revision: "5332fcc35e32a33b86612b9a57a89be7906102b1", weightBytes: 40_852_675,
  },
  {
    id: "base", label: "Whisper Base", description: "Баланс точности и скорости",
    hardwareHint: "Для обычных компьютеров", repository: "Xenova/whisper-base",
    revision: "64da57285918e20ea79ea5c88eed7197933abaa8", weightBytes: 76_908_389,
  },
  {
    id: "small", label: "Whisper Small", description: "Более крупная модель, выше нагрузка и задержка",
    hardwareHint: "Для мощных компьютеров; выбирается вручную", repository: "Xenova/whisper-small",
    revision: "2d67713f236afa48a18992566e7647f6ca848e13", weightBytes: 249_105_759,
  },
];

export interface TranslationHardware {
  /** Browser-provided approximation of the device's memory, when available. */
  deviceMemoryGB?: number;
  logicalCores?: number;
}

export function isTranslationModelId(value: unknown): value is TranslationModelId {
  return TRANSLATION_MODELS.some(model => model.id === value);
}

export function getModelProfile(id: TranslationModelId): TranslationModelProfile {
  return TRANSLATION_MODELS.find(model => model.id === id)!;
}

export function resolveModelChoice(choice: TranslationModelChoice, hardware: TranslationHardware = {}): TranslationModelId {
  if (choice !== "auto") return choice;
  const memory = hardware.deviceMemoryGB;
  const cores = hardware.logicalCores;
  const limitedMemory = typeof memory === "number" && Number.isFinite(memory) && memory > 0 && memory <= 4;
  const limitedCores = typeof cores === "number" && Number.isFinite(cores) && cores > 0 && cores <= 4;
  // Avoid unexpectedly loading Small during a call. The user can opt into it
  // after comparing actual local processing times with the audio duration.
  return limitedMemory || limitedCores ? "tiny" : "base";
}
