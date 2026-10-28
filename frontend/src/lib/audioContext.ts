export async function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state === "closed") throw new Error("Звуковой движок закрыт. Переподключи микрофон.");
  if (context.state === "running") return;
  let timer = 0;
  try {
    await Promise.race([context.resume(), new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("Звуковой движок не запустился. Нажми включение микрофона ещё раз.")), 4000);
    })]);
    if ((context.state as AudioContextState) !== "running") throw new Error("Обработка звука приостановлена.");
  } finally { window.clearTimeout(timer); }
}
