import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const scenarioIndex = args.indexOf("--scenario");
let scenario;

if (scenarioIndex >= 0) {
  scenario = args[scenarioIndex + 1];
  args.splice(scenarioIndex, 2);
}

if (scenario && scenario !== "layout-spike") {
  console.error(`Unknown performance scenario: ${scenario}`);
  process.exit(2);
}

const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (scenario === "layout-spike") {
  run(["exec", "vitest", "run", "--config", "vitest.perf.config.ts", ...args]);
  process.exit(0);
}

run(["--filter", "@er-diagram/test-fixtures", "test", "test/performance-profile.test.ts"]);
run(["exec", "vitest", "run", "--config", "vitest.perf.config.ts"]);
run(["--filter", "@er-diagram/contracts", "build"]);
run(["--filter", "@er-diagram/core", "build"]);
run(["--filter", "@er-diagram/test-fixtures", "build"]);
run(["exec", "playwright", "test", "--config", "playwright.performance.config.ts", ...args]);

function run(commandArgs) {
  const result = spawnSync(executable, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
