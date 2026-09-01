#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { requiredOciMetadata } from "./release-image-evidence.mjs";

const [reference, version, revision] = process.argv.slice(2);
if (!reference || !version || !revision) fail("RELEASE_RUNTIME_ARGUMENT_INVALID");
const metadata = requiredOciMetadata({ version, revision });
const results = [];

try {
  for (const architecture of ["amd64", "arm64"]) {
    run(["pull", "--platform", `linux/${architecture}`, reference]);
    const config = JSON.parse(
      capture(["image", "inspect", reference, "--format", "{{json .Config}}"]),
    );
    assert.equal(config.User, "node");
    assert.deepEqual(config.Cmd, ["node", "dist/production-entrypoint.js"]);
    for (const [key, value] of Object.entries(metadata)) assert.equal(config.Labels?.[key], value);
    const runtime = JSON.parse(
      capture([
        "run",
        "--rm",
        "--platform",
        `linux/${architecture}`,
        "--entrypoint",
        "node",
        reference,
        "--input-type=module",
        "-e",
        probe(),
      ]),
    );
    assert.deepEqual(runtime, {
      architecture,
      uid: 1000,
      version,
      sourceRevision: revision,
      parserVersion: "9.1.1",
      bundleSchemaVersion: 1,
      parsedTableCount: 1,
    });
    results.push({ platform: `linux/${architecture}`, ...runtime });
    run(["image", "rm", "--force", reference]);
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", platforms: results })}\n`);
} catch {
  fail("RELEASE_RUNTIME_SMOKE_FAILED");
}

function probe() {
  return `
    import { readFileSync } from "node:fs";
    const identity = JSON.parse(readFileSync("/app/release.json", "utf8"));
    const serverPackage = await import("/app/server/dist/index.js");
    const executor = serverPackage.createResourceExecutor({
      operationalLogSink: serverPackage.NOOP_OPERATIONAL_LOG_SINK,
    });
    let parsed;
    try {
      parsed = await executor.parseDbml("Table public.release_smoke { id int [pk] }", "/main.dbml");
    } finally {
      await executor.close();
    }
    if (!parsed?.ok) throw new Error("release resource worker failed");
    console.log(JSON.stringify({
      architecture: process.arch === "x64" ? "amd64" : process.arch,
      uid: process.getuid?.(),
      version: identity.version,
      sourceRevision: identity.sourceRevision,
      parserVersion: identity.parserVersion,
      bundleSchemaVersion: identity.bundleSchemaVersion,
      parsedTableCount: parsed.graph.tables.length,
    }));
  `;
}

function capture(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(args) {
  execFileSync("docker", args, { stdio: "inherit" });
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}
