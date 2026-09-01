import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scanner = fileURLToPath(
  new URL("../../../scripts/check-web-security-sinks.mjs", import.meta.url),
);
const productionSource = fileURLToPath(new URL("../src", import.meta.url));
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("production Web security sink scan", () => {
  it("allows the current production source only when no executable HTML sink is present", () => {
    const result = runScanner(productionSource);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails closed for every prohibited HTML or code-execution sink", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "er-diagram-web-sinks-"));
    temporaryDirectories.add(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "unsafe.tsx"),
      [
        "const html = '<b>unsafe</b>';",
        "const one = { dangerouslySetInnerHTML: { __html: html } };",
        "element.innerHTML = html;",
        "element.outerHTML = html;",
        "element.insertAdjacentHTML('beforeend', html);",
        "document.write(html);",
        "frame.srcdoc = html;",
        "eval(html);",
        "new Function(html)();",
        "void one;",
      ].join("\n"),
      "utf8",
    );

    const result = runScanner(fixtureRoot);
    expect(result.status).toBe(1);
    for (const sink of [
      "dangerouslySetInnerHTML",
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "srcdoc",
      "eval",
      "Function constructor",
    ]) {
      expect(result.stderr).toContain(`forbidden ${sink} sink`);
    }
  });

  it("does not silently pass when its source root cannot be read", () => {
    const result = runScanner(join(tmpdir(), "er-diagram-missing-security-root"));
    expect(result.status).not.toBe(0);
  });
});

function runScanner(root: string): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(process.execPath, [scanner, "--root", root], {
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}
