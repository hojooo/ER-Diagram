import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  DEVELOPMENT_RUNTIME_RELEASE_IDENTITY,
  RUNTIME_CONFIG_VERSION,
  runtimeConfigResponseSchema,
  runtimeReleaseIdentitySchema,
} from "../src/index.js";

const RELEASE_IDENTITY = {
  channel: "RELEASE",
  version: "1.2.3",
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  imageReference: "ghcr.io/hojooo/er-diagram:1.2.3",
  parserVersion: "9.1.1",
  bundleSchemaVersion: 1,
} as const;
const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

describe("runtime release identity contract", () => {
  it("publishes a strict development identity in runtime config version 2", () => {
    const response = runtimeConfigResponseSchema.parse(DEFAULT_RUNTIME_CONFIG_RESPONSE);

    expect(response).toMatchObject({
      configVersion: RUNTIME_CONFIG_VERSION,
      release: DEVELOPMENT_RUNTIME_RELEASE_IDENTITY,
    });
    expect(cloneStructured(response)).toEqual(response);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it("accepts only stable release evidence tied to the exact GHCR version tag", () => {
    expect(runtimeReleaseIdentitySchema.parse(RELEASE_IDENTITY)).toEqual(RELEASE_IDENTITY);
    expect(
      runtimeReleaseIdentitySchema.safeParse({ ...RELEASE_IDENTITY, version: "1.2.3-rc.1" })
        .success,
    ).toBe(false);
    expect(
      runtimeReleaseIdentitySchema.safeParse({
        ...RELEASE_IDENTITY,
        sourceRevision: RELEASE_IDENTITY.sourceRevision.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      runtimeReleaseIdentitySchema.safeParse({
        ...RELEASE_IDENTITY,
        imageReference: "ghcr.io/hojooo/er-diagram:latest",
      }).success,
    ).toBe(false);
  });

  it("rejects hybrid, incomplete, and unknown-field identities", () => {
    expect(
      runtimeReleaseIdentitySchema.safeParse({
        ...DEVELOPMENT_RUNTIME_RELEASE_IDENTITY,
        sourceRevision: RELEASE_IDENTITY.sourceRevision,
      }).success,
    ).toBe(false);
    expect(
      runtimeReleaseIdentitySchema.safeParse({ ...RELEASE_IDENTITY, extra: true }).success,
    ).toBe(false);
    expect(
      runtimeConfigResponseSchema.safeParse({
        ...DEFAULT_RUNTIME_CONFIG_RESPONSE,
        release: undefined,
      }).success,
    ).toBe(false);
  });
});
