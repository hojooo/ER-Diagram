import { lstatSync, readFileSync } from "node:fs";
import {
  utf8ByteLength,
  type RuntimeReleaseIdentity,
  runtimeReleaseIdentitySchema,
} from "@er-diagram/contracts";

const MAX_RELEASE_MANIFEST_BYTES = 8 * 1024;

export function readRuntimeReleaseIdentityFile(filename: string): RuntimeReleaseIdentity {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RELEASE_MANIFEST_BYTES) {
    throw new Error("The packaged release manifest is not a small regular file.");
  }
  const source = readFileSync(filename, "utf8");
  if (utf8ByteLength(source) !== stat.size) {
    throw new Error("The packaged release manifest is not valid UTF-8.");
  }
  return runtimeReleaseIdentitySchema.parse(JSON.parse(source) as unknown);
}
