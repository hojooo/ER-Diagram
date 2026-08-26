import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const SOURCE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const FRAMEWORK_FREE_PACKAGES = new Set(["packages/core", "packages/source-transform"]);
const FORBIDDEN_FRAMEWORK_PACKAGES = new Set([
  "@xyflow/react",
  "better-sqlite3",
  "drizzle-orm",
  "fastify",
  "react",
  "react-dom",
]);
const FORBIDDEN_PLATFORM_LIBS = new Set(["dom", "dom.iterable", "scripthost", "webworker"]);

export function analyzeSourceArchitecture(repositoryRoot) {
  const files = packageSourceFiles(repositoryRoot);
  const packageBySpecifier = discoverInternalPackages(repositoryRoot);
  const packageEdges = new Map();
  const violations = [];

  for (const absolutePath of files) {
    const filepath = repositoryPath(repositoryRoot, absolutePath);
    const sourcePackage = packageForRepositoryPath(filepath);
    if (!sourcePackage) continue;

    const source = readFileSync(absolutePath, "utf8");
    const imports = extractModuleSpecifiers(source);

    for (const specifier of imports) {
      enforceImportRules({ filepath, sourcePackage, specifier, violations });
      const targetPackage = resolveTargetPackage({
        absolutePath,
        packageBySpecifier,
        repositoryRoot,
        specifier,
      });
      if (!targetPackage || targetPackage === sourcePackage) continue;

      const targets = packageEdges.get(sourcePackage) ?? new Set();
      targets.add(targetPackage);
      packageEdges.set(sourcePackage, targets);
    }

    if (FRAMEWORK_FREE_PACKAGES.has(sourcePackage)) {
      for (const library of extractLibReferences(source)) {
        if (FORBIDDEN_PLATFORM_LIBS.has(library.toLowerCase())) {
          violations.push({
            rule: "framework-free-platform-libs",
            filepath,
            message: `${sourcePackage} references forbidden platform lib ${library}.`,
          });
        }
      }
    }
  }

  enforceFrameworkFreeTsconfigs(repositoryRoot, violations);
  violations.push(...findPackageCycles(packageEdges));

  return {
    modules: files.length,
    packageEdges: [...packageEdges.values()].reduce((count, targets) => count + targets.size, 0),
    violations,
  };
}

function enforceImportRules({ filepath, sourcePackage, specifier, violations }) {
  const externalPackage = packageNameFromSpecifier(specifier);

  if (sourcePackage !== "apps/server" && externalPackage === "fastify") {
    violations.push({
      rule: "fastify-only-in-server-adapter",
      filepath,
      message: `Fastify import is not allowed from ${sourcePackage}: ${specifier}`,
    });
  }

  if (
    FRAMEWORK_FREE_PACKAGES.has(sourcePackage) &&
    FORBIDDEN_FRAMEWORK_PACKAGES.has(externalPackage)
  ) {
    violations.push({
      rule: "framework-free-core-and-source-transform",
      filepath,
      message: `${sourcePackage} imports forbidden framework dependency ${specifier}.`,
    });
  }

  if (
    sourcePackage === "apps/web" &&
    (specifier === "@er-diagram/storage-sqlite" ||
      specifier.startsWith("@er-diagram/storage-sqlite/"))
  ) {
    violations.push({
      rule: "web-must-not-import-storage-sqlite",
      filepath,
      message: `The web adapter imports the SQLite adapter: ${specifier}`,
    });
  }
}

function enforceFrameworkFreeTsconfigs(repositoryRoot, violations) {
  for (const sourcePackage of FRAMEWORK_FREE_PACKAGES) {
    const filepath = `${sourcePackage}/tsconfig.json`;
    const absolutePath = join(repositoryRoot, filepath);
    if (!existsSync(absolutePath)) continue;

    const config = JSON.parse(readFileSync(absolutePath, "utf8"));
    for (const library of config.compilerOptions?.lib ?? []) {
      if (!FORBIDDEN_PLATFORM_LIBS.has(String(library).toLowerCase())) continue;
      violations.push({
        rule: "framework-free-platform-libs",
        filepath,
        message: `${sourcePackage} enables forbidden platform lib ${library}.`,
      });
    }
  }
}

function findPackageCycles(packageEdges) {
  const violations = [];
  const state = new Map();
  const stack = [];
  const reported = new Set();
  const packages = new Set(packageEdges.keys());
  for (const targets of packageEdges.values()) {
    for (const target of targets) packages.add(target);
  }

  function visit(sourcePackage) {
    state.set(sourcePackage, "visiting");
    stack.push(sourcePackage);

    for (const targetPackage of packageEdges.get(sourcePackage) ?? []) {
      if (state.get(targetPackage) === "visiting") {
        const cycleStart = stack.indexOf(targetPackage);
        const cycle = [...stack.slice(cycleStart), targetPackage];
        const signature = [...new Set(cycle)].toSorted().join("|");
        if (!reported.has(signature)) {
          reported.add(signature);
          violations.push({
            rule: "no-circular-package-dependencies",
            filepath: sourcePackage,
            message: `Package dependency cycle: ${cycle.join(" -> ")}`,
          });
        }
        continue;
      }
      if (state.get(targetPackage) !== "visited") visit(targetPackage);
    }

    stack.pop();
    state.set(sourcePackage, "visited");
  }

  for (const sourcePackage of [...packages].toSorted()) {
    if (!state.has(sourcePackage)) visit(sourcePackage);
  }
  return violations;
}

function resolveTargetPackage({ absolutePath, packageBySpecifier, repositoryRoot, specifier }) {
  if (specifier.startsWith("@er-diagram/")) {
    return packageBySpecifier.get(packageNameFromSpecifier(specifier)) ?? null;
  }
  if (!specifier.startsWith(".")) return null;

  const targetPath = repositoryPath(repositoryRoot, resolve(dirname(absolutePath), specifier));
  return packageForRepositoryPath(targetPath);
}

function discoverInternalPackages(repositoryRoot) {
  const result = new Map();
  for (const parent of ["apps", "packages"]) {
    const parentPath = join(repositoryRoot, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = `${parent}/${entry.name}`;
      const manifestPath = join(repositoryRoot, packagePath, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string") result.set(manifest.name, packagePath);
      }
      result.set(`@er-diagram/${entry.name}`, packagePath);
    }
  }
  return result;
}

function packageForRepositoryPath(filepath) {
  const match = filepath.match(/^(apps|packages)\/([^/]+)(?:\/|$)/u);
  return match ? `${match[1]}/${match[2]}` : null;
}

function packageNameFromSpecifier(specifier) {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier;
  return specifier.split("/").slice(0, 2).join("/");
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
    if (entry.name.endsWith(".d.ts")) return [];
    return [absolutePath];
  });
}

function packageSourceFiles(repositoryRoot) {
  return ["apps", "packages"].flatMap((parent) => {
    const parentPath = join(repositoryRoot, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sourceFiles(join(parentPath, entry.name, "src")) : [],
    );
  });
}

function repositoryPath(repositoryRoot, absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function extractModuleSpecifiers(source) {
  const tokens = tokenizeModuleSyntax(source);
  const specifiers = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word" || (token.value !== "import" && token.value !== "export")) {
      continue;
    }

    const next = tokens[index + 1];
    if (token.value === "import" && next?.kind === "punctuation" && next.value === ".") {
      continue;
    }
    if (token.value === "import" && next?.kind === "punctuation" && next.value === "(") {
      const dynamicSpecifier = tokens[index + 2];
      if (dynamicSpecifier?.kind === "string") specifiers.push(dynamicSpecifier.value);
      continue;
    }
    if (token.value === "import" && next?.kind === "string") {
      specifiers.push(next.value);
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate?.kind === "punctuation" && candidate.value === ";") break;
      if (candidate?.kind === "word" && candidate.value === "from") {
        const specifier = tokens[cursor + 1];
        if (specifier?.kind === "string") specifiers.push(specifier.value);
        break;
      }
    }
  }

  return specifiers;
}

function extractLibReferences(source) {
  return [...source.matchAll(/<reference\s+lib\s*=\s*["']([^"']+)["']/gu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function tokenizeModuleSyntax(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/u.test(character ?? "")) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = skipUntil(source, index + 2, "\n");
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const parsed = readQuotedString(source, index, character);
      tokens.push({ kind: "string", value: parsed.value });
      index = parsed.end;
      continue;
    }
    if (character === "`") {
      index = skipTemplateLiteral(source, index + 1);
      continue;
    }
    if (/[A-Za-z_$]/u.test(character ?? "")) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/u.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "word", value: source.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }

  return tokens;
}

function readQuotedString(source, start, quote) {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      if (index + 1 < source.length) value += source[index + 1];
      index += 2;
      continue;
    }
    if (character === quote) return { value, end: index + 1 };
    value += character;
    index += 1;
  }
  return { value, end: source.length };
}

function skipTemplateLiteral(source, start) {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") return index + 1;
    index += 1;
  }
  return source.length;
}

function skipUntil(source, start, marker) {
  const end = source.indexOf(marker, start);
  return end === -1 ? source.length : end + marker.length;
}
