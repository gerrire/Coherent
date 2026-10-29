import { expect, it } from "vitest";
import { processCpu, processReport, type ProcessEntry, type ProcessMetrics } from "../src/lib/processMetrics";
const entry = (pid: number, cpuMs: number, createdAt = 1): ProcessEntry => ({ pid, parentPid: 0, image: "msedgewebview2.exe", kind: "renderer", createdAt, cpuMs, privateBytes: 1048576, residentPrivateBytes: 524288, workingBytes: 1048576 });
const metrics = (entries: ProcessEntry[]): ProcessMetrics => ({ entries, processes: entries.length, measuredProcesses: entries.length, complete: true, privateBytes: 1048576, residentPrivateBytes: 524288, workingBytes: 1048576, logicalProcessors: 4 });

it("keeps surviving process CPU deltas when another renderer exits or a PID is reused", () => {
  const before = metrics([entry(1, 1000), entry(2, 8000), entry(3, 50)]);
  const after = metrics([entry(1, 1400), entry(3, 5000, 2), entry(4, 9000)]);
  expect(processCpu(before, after, 1000)).toBe(10);
  expect(processCpu(before, after, 0)).toBeNull();
});
it("reports exact PIDs, distinguishes resident and committed memory, and marks incomplete data", () => {
  const value = metrics([entry(42, 0)]); value.complete = false;
  const report = processReport(value);
  expect(report).toContain("В ОЗУ: 0.5 МБ; выделено: 1.0 МБ");
  expect(report).toContain("msedgewebview2.exe\t42");
  expect(report).toContain("могут быть неполными");
});
