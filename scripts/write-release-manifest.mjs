import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const output = process.argv[2];
if (!output) fail("RELEASE_MANIFEST_OUTPUT_REQUIRED");

const channel = process.env.RUNTIME_RELEASE_CHANNEL ?? "DEVELOPMENT";
const parserVersion = "9.1.1";
const bundleSchemaVersion = 1;
let identity;

if (channel === "DEVELOPMENT") {
  identity = {
    channel,
    version: "development",
    sourceRevision: null,
    imageReference: null,
    parserVersion,
    bundleSchemaVersion,
  };
} else if (channel === "RELEASE") {
  const version = process.env.RUNTIME_RELEASE_VERSION ?? "";
  const sourceRevision = process.env.RUNTIME_RELEASE_SOURCE_REVISION ?? "";
  const imageReference = process.env.RUNTIME_RELEASE_IMAGE_REFERENCE ?? "";
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    fail("RELEASE_VERSION_INVALID");
  }
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) fail("RELEASE_SOURCE_REVISION_INVALID");
  if (imageReference !== `ghcr.io/hojooo/er-diagram:${version}`) {
    fail("RELEASE_IMAGE_REFERENCE_INVALID");
  }
  identity = {
    channel,
    version,
    sourceRevision,
    imageReference,
    parserVersion,
    bundleSchemaVersion,
  };
} else {
  fail("RELEASE_CHANNEL_INVALID");
}

const filename = resolve(output);
mkdirSync(dirname(filename), { recursive: true });
writeFileSync(filename, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o644 });

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}
