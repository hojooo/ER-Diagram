#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

import { requiredOciMetadata } from "./release-image-evidence.mjs";

const [reference, version, revision] = process.argv.slice(2);
if (!reference || !version || !revision) fail("RELEASE_REMOTE_ARGUMENT_INVALID");

try {
  const metadata = requiredOciMetadata({ version, revision });
  const summary = capture(["buildx", "imagetools", "inspect", reference]);
  const digest = /^Digest:\s+(sha256:[0-9a-f]{64})$/mu.exec(summary)?.[1];
  if (!digest) fail("RELEASE_REMOTE_DIGEST_INVALID");
  const rawIndex = capture(["buildx", "imagetools", "inspect", reference, "--raw"]);
  const index = JSON.parse(rawIndex);
  if (
    index.schemaVersion !== 2 ||
    index.mediaType !== "application/vnd.oci.image.index.v1+json" ||
    !Array.isArray(index.manifests)
  ) {
    fail("RELEASE_REMOTE_INDEX_INVALID");
  }
  assertMetadata(index.annotations, metadata, "RELEASE_REMOTE_INDEX_ANNOTATION_INVALID");
  const platforms = index.manifests
    .map((descriptor) => {
      const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
      if (
        !["linux/amd64", "linux/arm64"].includes(platform) ||
        descriptor.platform?.variant !== undefined ||
        !/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest ?? "")
      ) {
        fail("RELEASE_REMOTE_PLATFORM_INVALID");
      }
      const rawManifest = capture([
        "buildx",
        "imagetools",
        "inspect",
        `${reference.split("@")[0]}@${descriptor.digest}`,
        "--raw",
      ]);
      const manifest = JSON.parse(rawManifest);
      assertMetadata(manifest.annotations, metadata, "RELEASE_REMOTE_MANIFEST_ANNOTATION_INVALID");
      return platform;
    })
    .sort();
  if (JSON.stringify(platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])) {
    fail("RELEASE_REMOTE_PLATFORM_SET_INVALID");
  }
  process.stdout.write(
    `${JSON.stringify({
      digest,
      version,
      sourceRevision: revision,
      platforms,
    })}\n`,
  );
} catch {
  fail("RELEASE_REMOTE_INSPECTION_FAILED");
}

function capture(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function assertMetadata(actual, expected, code) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) fail(code);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) fail(code);
  }
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}
