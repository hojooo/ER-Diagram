import { randomBytes } from "node:crypto";

const UUID_V7_RANDOM_BYTES = 10;
const UUID_V7_MAX_TIMESTAMP = 0xffff_ffff_ffff;
const MAX_CANONICAL_UTC_EPOCH_MS = 253_402_300_799_999;

function assertEpochMilliseconds(epochMs: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > maximum) {
    throw new RangeError(`${label} must be a non-negative safe integer within its supported range`);
  }
}

/** @internal Exported from this module, but not from the package entrypoint, for deterministic tests. */
export function encodeUuidV7(epochMs: number, random: Uint8Array): string {
  assertEpochMilliseconds(epochMs, UUID_V7_MAX_TIMESTAMP, "UUIDv7 epochMs");
  if (random.byteLength !== UUID_V7_RANDOM_BYTES) {
    throw new RangeError(`UUIDv7 random input must contain ${UUID_V7_RANDOM_BYTES} bytes`);
  }

  const bytes = new Uint8Array(16);
  let remainingTimestamp = epochMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }
  bytes.set(random, 6);

  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("UUIDv7 byte buffer was not initialized");
  }
  bytes[6] = (versionByte & 0x0f) | 0x70;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

export function generateUuidV7(): string {
  return encodeUuidV7(Date.now(), randomBytes(UUID_V7_RANDOM_BYTES));
}

export function toUtcIsoTimestamp(epochMs = Date.now()): string {
  assertEpochMilliseconds(epochMs, MAX_CANONICAL_UTC_EPOCH_MS, "UTC epochMs");
  return new Date(epochMs).toISOString();
}
