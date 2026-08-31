import type { Stats } from "node:fs";
import { close, constants, fstat, open } from "node:fs";
import type { Readable } from "node:stream";

import { bundleResourceLimitsSchema, type RuntimeResourceLimits } from "@er-diagram/contracts";
import { type Entry, fromFdPromise, type ZipFile } from "yauzl";

export type BoundedZipLimits = RuntimeResourceLimits["bundle"];

export type BoundedZipArchiveErrorCode =
  | "BUNDLE_ARCHIVE_OPEN_FAILED"
  | "BUNDLE_ARCHIVE_NOT_REGULAR_FILE"
  | "BUNDLE_ARCHIVE_TOO_LARGE"
  | "BUNDLE_ARCHIVE_INVALID"
  | "BUNDLE_ARCHIVE_TOO_MANY_ENTRIES"
  | "BUNDLE_ARCHIVE_ENTRY_PATH_INVALID"
  | "BUNDLE_ARCHIVE_ENTRY_PATH_COLLISION"
  | "BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED"
  | "BUNDLE_ARCHIVE_ENTRY_ENCRYPTED"
  | "BUNDLE_ARCHIVE_COMPRESSION_UNSUPPORTED"
  | "BUNDLE_ARCHIVE_ENTRY_TOO_LARGE"
  | "BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE";

export class BoundedZipArchiveError extends Error {
  constructor(readonly code: BoundedZipArchiveErrorCode) {
    super(publicBoundedZipArchiveErrorMessage(code));
    this.name = "BoundedZipArchiveError";
  }
}

export interface BoundedZipArchiveEntry {
  readonly path: string;
  readonly content: Buffer;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
}

export interface BoundedZipArchiveSummary {
  readonly entryCount: number;
  readonly fileCount: number;
  readonly expandedBytes: number;
}

export type BoundedZipArchiveVisitor = (entry: BoundedZipArchiveEntry) => Promise<void> | void;

interface ValidatedFileEntry {
  readonly entry: Entry;
  readonly path: string;
}

interface ValidatedArchiveMetadata {
  readonly entryCount: number;
  readonly files: ValidatedFileEntry[];
  readonly declaredExpandedBytes: number;
}

const UNIX_HOST_SYSTEM = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);
const CONTROL_CHARACTER = /\p{Cc}/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const YAUZL_PATH_ERROR_PREFIXES = [
  "invalid characters in fileName:",
  "absolute path:",
  "invalid relative path:",
] as const;

/**
 * Reads a ZIP through one bounded decompression stream at a time. The reader
 * never creates filesystem entries and does not invoke the visitor until every
 * central-directory entry has passed metadata validation.
 */
export async function readBoundedZipArchive(
  filename: string,
  limitsInput: BoundedZipLimits,
  visitor: BoundedZipArchiveVisitor,
): Promise<BoundedZipArchiveSummary> {
  const limits = parseLimits(limitsInput);
  let fileDescriptor: number | null = null;
  let zipFile: ZipFile | null = null;
  let outcome:
    | { readonly ok: true; readonly summary: BoundedZipArchiveSummary }
    | { readonly ok: false; readonly error: unknown };

  try {
    fileDescriptor = await openArchiveFile(filename);
    const stats = await statArchiveFile(fileDescriptor);
    if (!stats.isFile()) {
      throw archiveError("BUNDLE_ARCHIVE_NOT_REGULAR_FILE");
    }
    if (!Number.isSafeInteger(stats.size) || stats.size > limits.maxArchiveBytes) {
      throw archiveError("BUNDLE_ARCHIVE_TOO_LARGE");
    }

    try {
      zipFile = await fromFdPromise(fileDescriptor, {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        // Actual decompressed byte counts are enforced below so a forged
        // declared size cannot defer the configured limit check to yauzl's
        // generic size-mismatch error.
        validateEntrySizes: false,
      });
      fileDescriptor = null;
    } catch (error) {
      throw mapArchiveStructureError(error);
    }

    if (zipFile.fileSize !== stats.size) {
      throw archiveError("BUNDLE_ARCHIVE_INVALID");
    }

    const metadata = await validateArchiveMetadata(zipFile, limits);
    let actualExpandedBytes = 0;

    for (const file of metadata.files) {
      const remainingExpandedBytes = limits.maxExpandedBytes - actualExpandedBytes;
      const content = await readEntryContent(
        zipFile,
        file.entry,
        limits.maxEntryBytes,
        remainingExpandedBytes,
      );
      actualExpandedBytes += content.length;
      await visitor({
        path: file.path,
        content,
        compressedBytes: file.entry.compressedSize,
        uncompressedBytes: content.length,
      });
    }

    if (actualExpandedBytes !== metadata.declaredExpandedBytes) {
      throw archiveError("BUNDLE_ARCHIVE_INVALID");
    }

    outcome = {
      ok: true,
      summary: {
        entryCount: metadata.entryCount,
        fileCount: metadata.files.length,
        expandedBytes: actualExpandedBytes,
      },
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    if (zipFile !== null) await closeZipFile(zipFile);
    else if (fileDescriptor !== null) await closeFileDescriptor(fileDescriptor);
  } catch (error) {
    cleanupError = error;
  }

  if (!outcome.ok) throw outcome.error;
  if (cleanupError !== undefined) throw mapArchiveStructureError(cleanupError);
  return outcome.summary;
}

export function publicBoundedZipArchiveErrorMessage(code: BoundedZipArchiveErrorCode): string {
  switch (code) {
    case "BUNDLE_ARCHIVE_OPEN_FAILED":
      return "The bundle archive could not be opened safely.";
    case "BUNDLE_ARCHIVE_NOT_REGULAR_FILE":
      return "The bundle archive must be a regular file.";
    case "BUNDLE_ARCHIVE_TOO_LARGE":
      return "The bundle archive exceeds the configured byte limit.";
    case "BUNDLE_ARCHIVE_INVALID":
      return "The bundle archive is invalid or corrupt.";
    case "BUNDLE_ARCHIVE_TOO_MANY_ENTRIES":
      return "The bundle archive exceeds the configured entry count limit.";
    case "BUNDLE_ARCHIVE_ENTRY_PATH_INVALID":
      return "The bundle archive contains an unsafe entry path.";
    case "BUNDLE_ARCHIVE_ENTRY_PATH_COLLISION":
      return "The bundle archive contains colliding portable entry paths.";
    case "BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED":
      return "The bundle archive contains an unsupported entry type.";
    case "BUNDLE_ARCHIVE_ENTRY_ENCRYPTED":
      return "Encrypted bundle archive entries are not supported.";
    case "BUNDLE_ARCHIVE_COMPRESSION_UNSUPPORTED":
      return "The bundle archive uses an unsupported compression method.";
    case "BUNDLE_ARCHIVE_ENTRY_TOO_LARGE":
      return "A bundle archive entry exceeds the configured byte limit.";
    case "BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE":
      return "The expanded bundle archive exceeds the configured byte limit.";
  }
}

function parseLimits(input: BoundedZipLimits): BoundedZipLimits {
  try {
    return bundleResourceLimitsSchema.parse(input);
  } catch {
    throw new TypeError("Bounded ZIP limits must satisfy the runtime resource contract.");
  }
}

async function validateArchiveMetadata(
  zipFile: ZipFile,
  limits: BoundedZipLimits,
): Promise<ValidatedArchiveMetadata> {
  if (!Number.isSafeInteger(zipFile.entryCount) || zipFile.entryCount > limits.maxEntries) {
    throw archiveError("BUNDLE_ARCHIVE_TOO_MANY_ENTRIES");
  }

  const portablePaths = new Set<string>();
  const files: ValidatedFileEntry[] = [];
  let entryCount = 0;
  let declaredExpandedBytes = 0;

  try {
    for await (const entry of zipFile.eachEntry()) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw archiveError("BUNDLE_ARCHIVE_TOO_MANY_ENTRIES");
      }

      const path = validatePortableEntryPath(entry.fileName);
      const portablePath = portableCollisionKey(path);
      if (portablePaths.has(portablePath)) {
        throw archiveError("BUNDLE_ARCHIVE_ENTRY_PATH_COLLISION");
      }
      portablePaths.add(portablePath);

      validateEntryEncoding(entry);
      const directory = validateEntryType(entry, path);
      validateEntrySizeFields(entry, zipFile.fileSize);

      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw archiveError("BUNDLE_ARCHIVE_ENTRY_TOO_LARGE");
      }
      if (entry.uncompressedSize > limits.maxExpandedBytes - declaredExpandedBytes) {
        throw archiveError("BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE");
      }
      declaredExpandedBytes += entry.uncompressedSize;

      if (!directory) files.push({ entry, path });
    }
  } catch (error) {
    if (error instanceof BoundedZipArchiveError) throw error;
    throw mapArchiveStructureError(error);
  }

  if (entryCount !== zipFile.entryCount) {
    throw archiveError("BUNDLE_ARCHIVE_INVALID");
  }

  return { entryCount, files, declaredExpandedBytes };
}

function validatePortableEntryPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    WINDOWS_DRIVE_PATH.test(path) ||
    path.includes("\\") ||
    CONTROL_CHARACTER.test(path)
  ) {
    throw archiveError("BUNDLE_ARCHIVE_ENTRY_PATH_INVALID");
  }

  const pathWithoutDirectoryMarker = path.endsWith("/") ? path.slice(0, -1) : path;
  if (pathWithoutDirectoryMarker.length === 0) {
    throw archiveError("BUNDLE_ARCHIVE_ENTRY_PATH_INVALID");
  }
  const segments = pathWithoutDirectoryMarker.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw archiveError("BUNDLE_ARCHIVE_ENTRY_PATH_INVALID");
  }

  return path;
}

function portableCollisionKey(path: string): string {
  const withoutDirectoryMarker = path.endsWith("/") ? path.slice(0, -1) : path;
  return withoutDirectoryMarker.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function validateEntryEncoding(entry: Entry): void {
  if (entry.isEncrypted()) {
    throw archiveError("BUNDLE_ARCHIVE_ENTRY_ENCRYPTED");
  }
  if (!SUPPORTED_COMPRESSION_METHODS.has(entry.compressionMethod) || !entry.canDecodeFileData()) {
    throw archiveError("BUNDLE_ARCHIVE_COMPRESSION_UNSUPPORTED");
  }
}

function validateEntryType(entry: Entry, path: string): boolean {
  const hostSystem = entry.versionMadeBy >>> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixType = hostSystem === UNIX_HOST_SYSTEM ? unixMode & UNIX_FILE_TYPE_MASK : 0;
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    throw archiveError("BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED");
  }

  const hasDirectoryPath = path.endsWith("/");
  const hasUnixDirectoryType = unixType === UNIX_DIRECTORY;
  const hasDosDirectoryAttribute = (entry.externalFileAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0;
  const directory = hasDirectoryPath || hasUnixDirectoryType || hasDosDirectoryAttribute;

  if (directory) {
    if (
      !hasDirectoryPath ||
      unixType === UNIX_REGULAR_FILE ||
      entry.uncompressedSize !== 0 ||
      entry.compressedSize !== 0
    ) {
      throw archiveError("BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED");
    }
    return true;
  }

  return false;
}

function validateEntrySizeFields(entry: Entry, archiveSize: number): void {
  for (const size of [
    entry.compressedSize,
    entry.uncompressedSize,
    entry.relativeOffsetOfLocalHeader,
  ]) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw archiveError("BUNDLE_ARCHIVE_INVALID");
    }
  }
  if (
    entry.relativeOffsetOfLocalHeader > archiveSize ||
    entry.compressedSize > archiveSize - entry.relativeOffsetOfLocalHeader
  ) {
    throw archiveError("BUNDLE_ARCHIVE_INVALID");
  }
  if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw archiveError("BUNDLE_ARCHIVE_INVALID");
  }
}

async function readEntryContent(
  zipFile: ZipFile,
  entry: Entry,
  maxEntryBytes: number,
  maxRemainingExpandedBytes: number,
): Promise<Buffer> {
  let stream: Readable;
  try {
    stream = await zipFile.openReadStreamPromise(entry);
  } catch (error) {
    throw mapArchiveStructureError(error);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxEntryBytes - bytes) {
        stream.destroy();
        throw archiveError("BUNDLE_ARCHIVE_ENTRY_TOO_LARGE");
      }
      if (buffer.length > maxRemainingExpandedBytes - bytes) {
        stream.destroy();
        throw archiveError("BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE");
      }
      bytes += buffer.length;
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof BoundedZipArchiveError) throw error;
    throw mapArchiveStructureError(error);
  }

  if (bytes !== entry.uncompressedSize) {
    throw archiveError("BUNDLE_ARCHIVE_INVALID");
  }
  return Buffer.concat(chunks, bytes);
}

function openArchiveFile(filename: string): Promise<number> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return new Promise((resolve, reject) => {
    open(filename, flags, (error, fileDescriptor) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(
          archiveError(
            code === "ELOOP" ? "BUNDLE_ARCHIVE_NOT_REGULAR_FILE" : "BUNDLE_ARCHIVE_OPEN_FAILED",
          ),
        );
        return;
      }
      resolve(fileDescriptor);
    });
  });
}

function statArchiveFile(fileDescriptor: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    fstat(fileDescriptor, (error, stats) => {
      if (error !== null) {
        reject(archiveError("BUNDLE_ARCHIVE_OPEN_FAILED"));
        return;
      }
      resolve(stats);
    });
  });
}

function closeFileDescriptor(fileDescriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    close(fileDescriptor, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeZipFile(zipFile: ZipFile): Promise<void> {
  if (!zipFile.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipFile.removeListener("close", onClose);
      zipFile.removeListener("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    zipFile.once("close", onClose);
    zipFile.once("error", onError);
    try {
      zipFile.close();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function mapArchiveStructureError(error: unknown): BoundedZipArchiveError {
  if (error instanceof BoundedZipArchiveError) return error;
  if (
    error instanceof Error &&
    YAUZL_PATH_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))
  ) {
    return archiveError("BUNDLE_ARCHIVE_ENTRY_PATH_INVALID");
  }
  return archiveError("BUNDLE_ARCHIVE_INVALID");
}

function archiveError(code: BoundedZipArchiveErrorCode): BoundedZipArchiveError {
  return new BoundedZipArchiveError(code);
}
