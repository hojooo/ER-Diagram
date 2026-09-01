import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sourceRangeSchema } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("CSP-safe contract validation", () => {
  it("keeps Zod jitless and validates objects without probing the Function constructor", () => {
    const functionProbe = vi.fn(() => {
      throw new Error("The Function constructor is forbidden by the production CSP.");
    });
    vi.stubGlobal("Function", functionProbe);

    expect(z.config().jitless).toBe(true);
    expect(
      sourceRangeSchema.safeParse({
        filepath: "/main.dbml",
        startOffset: 0,
        endOffset: 1,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
      }),
    ).toMatchObject({ success: true });
    expect(functionProbe).not.toHaveBeenCalled();
  });
});
