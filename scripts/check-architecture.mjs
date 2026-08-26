import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { analyzeSourceArchitecture } from "./check-source-architecture.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repositoryRoot, "dependency-cruiser.config.mjs");
const binarySuffix = process.platform === "win32" ? ".cmd" : "";
const depcruiseExecutable = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  `depcruise${binarySuffix}`,
);
const typescriptExecutable = join(repositoryRoot, "node_modules", ".bin", `tsc${binarySuffix}`);
const common = ["--config", configPath];

const sourceAnalysis = analyzeSourceArchitecture(repositoryRoot);
if (sourceAnalysis.violations.length > 0) {
  reportSourceViolations(sourceAnalysis.violations);
  process.exit(1);
}

const sourceSelfTest = analyzeSourceArchitecture(
  join(repositoryRoot, "tests", "architecture-fixtures"),
);
const expectedSourceRules = new Set([
  "framework-free-core-and-source-transform",
  "no-circular-package-dependencies",
]);
const observedSourceRules = new Set(sourceSelfTest.violations.map(({ rule }) => rule));
if (![...expectedSourceRules].every((rule) => observedSourceRules.has(rule))) {
  reportSourceViolations(sourceSelfTest.violations);
  console.error(
    "Source architecture self-test did not reject type-only framework and cycle imports.",
  );
  process.exit(1);
}

console.log(
  `Source architecture checks passed (${sourceAnalysis.modules} modules, ${sourceAnalysis.packageEdges} package dependencies).`,
);

const temporaryRoot = mkdtempSync(join(tmpdir(), "er-diagram-architecture-"));

try {
  const compilation = spawnSync(
    typescriptExecutable,
    ["--project", join(repositoryRoot, "tsconfig.architecture.json"), "--outDir", temporaryRoot],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
  );

  if (compilation.status !== 0) {
    process.exit(compilation.status ?? 1);
  }

  symlinkSync(
    join(repositoryRoot, "node_modules"),
    join(temporaryRoot, "node_modules"),
    "junction",
  );

  const actual = spawnSync(depcruiseExecutable, [...common, "apps", "packages"], {
    cwd: temporaryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (actual.status !== 0) {
    process.exit(actual.status ?? 1);
  }

  const negativeFixture = join("packages", "core", "forbidden-fastify.mjs");
  copyFileSync(
    join(repositoryRoot, "tests", "architecture-fixtures", negativeFixture),
    join(temporaryRoot, negativeFixture),
  );
  const negative = spawnSync(depcruiseExecutable, [...common, negativeFixture], {
    cwd: temporaryRoot,
    encoding: "utf8",
  });

  const negativeOutput = `${negative.stdout ?? ""}\n${negative.stderr ?? ""}`;
  if (negative.status === 0 || !negativeOutput.includes("fastify-only-in-server-adapter")) {
    process.stderr.write(negativeOutput);
    console.error("Architecture guard self-test did not reject the forbidden Fastify import.");
    process.exit(1);
  }

  console.log("Architecture checks passed, including the forbidden-dependency self-test.");
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function reportSourceViolations(violations) {
  for (const violation of violations) {
    console.error(`[${violation.rule}] ${violation.filepath}: ${violation.message}`);
  }
}
