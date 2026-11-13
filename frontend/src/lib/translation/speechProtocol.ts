export type SpeechWorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "speak"; text: string };

export type SpeechWorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "progress"; progress: number }
  | { id: number; type: "audio"; pcm: ArrayBuffer; sampleRate: number }
  | { id: number; type: "error"; message: string };
