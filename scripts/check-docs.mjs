import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "TASKLIST.md",
  "docs/product/PRD.md",
  "docs/adr/0001-vite-fastify-monorepo.md",
  "docs/adr/0002-dbml-canonical-source-fidelity.md",
  "docs/adr/0003-sqlite-persistence.md",
  "docs/adr/0004-fastify-adapter-boundary.md",
  "docs/adr/0005-sql-capability-matrix.md",
];
const forbiddenMarkers = /PROPOSED|OPEN-|IMPLEMENTATION_BLOCKER/u;
const ineffectivePnpmTestFilter =
  /\bpnpm\s+(?:(?:--filter|-F)\s+[^\s`;&|<>]+\s+)?test(?::[A-Za-z0-9:_-]+)?\s+--(?:\s+\S+|\s*$)/u;
const failures = [];

for (const filepath of requiredFiles) {
  if (!existsSync(join(repositoryRoot, filepath))) {
    failures.push(`${filepath}: required canonical document is missing`);
  }
}

if (existsSync(join(repositoryRoot, "PRD.md"))) {
  failures.push("PRD.md: root copy must not compete with docs/product/PRD.md");
}

for (const absolutePath of markdownFiles(repositoryRoot)) {
  const filepath = relative(repositoryRoot, absolutePath);
  const source = readFileSync(absolutePath, "utf8");
  const lines = source.split("\n");
  let fence = null;
  let tableWidth = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (/[\t ]+$/u.test(line)) {
      failures.push(`${filepath}:${lineNumber}: trailing whitespace`);
    }

    if (ineffectivePnpmTestFilter.test(line)) {
      failures.push(
        `${filepath}:${lineNumber}: pass the focused test filter directly without a standalone --`,
      );
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      fence = fence === null ? marker : fence === marker ? null : fence;
      tableWidth = null;
      continue;
    }

    if (fence !== null) continue;

    if (forbiddenMarkers.test(line)) {
      failures.push(`${filepath}:${lineNumber}: unresolved marker`);
    }

    if (line.trimStart().startsWith("|") && line.trimEnd().endsWith("|")) {
      const width = countUnescapedPipes(line);
      if (tableWidth !== null && width !== tableWidth) {
        failures.push(
          `${filepath}:${lineNumber}: table has ${width} pipes; expected ${tableWidth}`,
        );
      }
      tableWidth = width;
    } else {
      tableWidth = null;
    }
  }

  if (fence !== null) failures.push(`${filepath}: unclosed Markdown fence`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Documentation checks passed.");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) return [];
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolutePath);
    return extname(entry.name) === ".md" ? [absolutePath] : [];
  });
}

function countUnescapedPipes(line) {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && line[index - 1] !== "\\") count += 1;
  }
  return count;
}
