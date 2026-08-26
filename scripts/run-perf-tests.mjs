import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
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
const result = spawnSync(
  executable,
  ["exec", "vitest", "run", "--config", "vitest.perf.config.ts", ...args],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
