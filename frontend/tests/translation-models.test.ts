import { describe, expect, it } from "vitest";
import { resolveModelChoice } from "../src/lib/translation/models";

describe("automatic local model selection", () => {
  it("chooses Tiny when either available hardware signal suggests a limited device", () => {
    expect(resolveModelChoice("auto", { deviceMemoryGB: 4, logicalCores: 16 })).toBe("tiny");
    expect(resolveModelChoice("auto", { deviceMemoryGB: 16, logicalCores: 4 })).toBe("tiny");
    expect(resolveModelChoice("auto", { deviceMemoryGB: 0.5 })).toBe("tiny");
  });

  it("never silently loads Small, including on powerful or unknown hardware", () => {
    expect(resolveModelChoice("auto", { deviceMemoryGB: 64, logicalCores: 32 })).toBe("base");
    expect(resolveModelChoice("auto")).toBe("base");
    expect(resolveModelChoice("auto", { deviceMemoryGB: Number.NaN, logicalCores: -1 })).toBe("base");
  });

  it("respects a manual choice even when browser hardware information is limited", () => {
    expect(resolveModelChoice("small", { deviceMemoryGB: 4, logicalCores: 2 })).toBe("small");
    expect(resolveModelChoice("tiny", { deviceMemoryGB: 64, logicalCores: 32 })).toBe("tiny");
  });
});
