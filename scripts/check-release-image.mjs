#!/usr/bin/env node
import process from "node:process";

import { inspectOciLayout, ReleaseImageEvidenceError } from "./release-image-evidence.mjs";

const [layoutDirectory, version, revision] = process.argv.slice(2);
if (!layoutDirectory || !version || !revision) {
  process.stderr.write("RELEASE_IMAGE_INSPECT_ARGUMENT_INVALID\n");
  process.exit(1);
}

try {
  const evidence = inspectOciLayout(layoutDirectory, { version, revision });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof ReleaseImageEvidenceError ? error.code : "RELEASE_IMAGE_INSPECT_FAILED"}\n`,
  );
  process.exit(1);
}
