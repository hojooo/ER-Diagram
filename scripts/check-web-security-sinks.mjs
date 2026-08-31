#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORBIDDEN_SINKS = Object.freeze([
  ["dangerouslySetInnerHTML", /\bdangerouslySetInnerHTML\b/u],
  ["innerHTML", /\binnerHTML\b/u],
  ["outerHTML", /\bouterHTML\b/u],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/u],
  ["document.write", /\bdocument\s*\.\s*write\b/u],
  ["srcdoc", /\bsrcdoc\b/iu],
  ["eval", /\beval\b/u],
  ["Function constructor", /\bFunction\b/u],
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function findForbiddenWebSecuritySinks(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = await sourceFiles(root);
  const findings = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r\n|\r|\n/u);
    for (const [sink, pattern] of FORBIDDEN_SINKS) {
      for (let index = 0; index < lines.length; index += 1) {
        if (pattern.test(lines[index] ?? "")) {
          findings.push({ file, line: index + 1, sink });
        }
      }
    }
  }
  return findings;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function main() {
  const rootArgumentIndex = process.argv.indexOf("--root");
  const configuredRoot =
    rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : "apps/web/src";
  if (!configuredRoot) throw new Error("--root requires a directory path.");
  const findings = await findForbiddenWebSecuritySinks(configuredRoot);
  if (findings.length === 0) return;
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line}: forbidden ${finding.sink} sink\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
