import { z } from "./zod.js";

export const RUNTIME_CONFIG_VERSION = 2 as const;
export const RUNTIME_RELEASE_PARSER_VERSION = "9.1.1" as const;
export const RUNTIME_RELEASE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_RELEASE_IMAGE_REPOSITORY = "ghcr.io/hojooo/er-diagram" as const;

const stableSemverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const fullCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const runtimeReleaseIdentityBase = {
  parserVersion: z.literal(RUNTIME_RELEASE_PARSER_VERSION),
  bundleSchemaVersion: z.literal(RUNTIME_RELEASE_BUNDLE_SCHEMA_VERSION),
};

const developmentRuntimeReleaseIdentitySchema = z
  .object({
    channel: z.literal("DEVELOPMENT"),
    version: z.literal("development"),
    sourceRevision: z.null(),
    imageReference: z.null(),
    ...runtimeReleaseIdentityBase,
  })
  .strict();

const releaseRuntimeReleaseIdentitySchema = z
  .object({
    channel: z.literal("RELEASE"),
    version: stableSemverSchema,
    sourceRevision: fullCommitShaSchema,
    imageReference: z.string(),
    ...runtimeReleaseIdentityBase,
  })
  .strict()
  .superRefine((identity, context) => {
    const expected = `${RUNTIME_RELEASE_IMAGE_REPOSITORY}:${identity.version}`;
    if (identity.imageReference !== expected) {
      context.addIssue({
        code: "custom",
        message: "The release image reference must match the stable version.",
        path: ["imageReference"],
      });
    }
  });

export const runtimeReleaseIdentitySchema = z.discriminatedUnion("channel", [
  developmentRuntimeReleaseIdentitySchema,
  releaseRuntimeReleaseIdentitySchema,
]);

export type RuntimeReleaseIdentity = z.infer<typeof runtimeReleaseIdentitySchema>;

export const DEVELOPMENT_RUNTIME_RELEASE_IDENTITY = Object.freeze(
  runtimeReleaseIdentitySchema.parse({
    channel: "DEVELOPMENT",
    version: "development",
    sourceRevision: null,
    imageReference: null,
    parserVersion: RUNTIME_RELEASE_PARSER_VERSION,
    bundleSchemaVersion: RUNTIME_RELEASE_BUNDLE_SCHEMA_VERSION,
  }),
);
