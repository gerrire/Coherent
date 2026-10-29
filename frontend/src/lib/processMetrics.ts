export type ProcessEntry = {
  pid: number; parentPid: number; image: string; kind: string; createdAt: number;
  privateBytes: number | null; residentPrivateBytes: number | null;
  workingBytes: number | null; cpuMs: number;
};
export type ProcessMetrics = {
  processes: number; measuredProcesses: number; complete: boolean;
  privateBytes: number; residentPrivateBytes: number | null; workingBytes: number;
  logicalProcessors: number; entries: ProcessEntry[];
};
export const processRole = (kind: string) => ({
  native: "Клиент", browser: "Менеджер интерфейса", renderer: "Отрисовка интерфейса",
  gpu: "Графика и видео", utility: "Служба интерфейса", sandbox: "Изоляция",
  "runtime-helper": "Вспомогательный процесс",
}[kind] ?? "Служба интерфейса");

export function processCpu(previous: ProcessMetrics, next: ProcessMetrics, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || next.logicalProcessors <= 0) return null;
  const before = new Map(previous.entries.map(entry => [entry.pid, entry]));
  let delta = 0;
  for (const entry of next.entries) {
    const old = before.get(entry.pid);
    if (old && old.createdAt === entry.createdAt) delta += Math.max(0, entry.cpuMs - old.cpuMs);
  }
  // A restarted renderer must not reset the CPU usage of the surviving ones.
  return Math.min(100, delta / elapsedMs / next.logicalProcessors * 100);
}

export function processReport(metrics: ProcessMetrics): string {
  const mb = (bytes: number | null) => bytes === null ? "недоступно" : `${(bytes / 1048576).toFixed(1)} МБ`;
  return ["Процессы Coherent", `В ОЗУ: ${mb(metrics.residentPrivateBytes)}; выделено: ${mb(metrics.privateBytes)}`,
    ...(metrics.complete ? [] : ["Часть показателей недоступна; суммы могут быть неполными."]),
    "Роль\tФайл\tPID\tВ ОЗУ\tВыделено",
    ...metrics.entries.map(entry => `${processRole(entry.kind)}\t${entry.image}\t${entry.pid}\t${mb(entry.residentPrivateBytes)}\t${mb(entry.privateBytes)}`),
  ].join("\n");
}
