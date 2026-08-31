import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, type ReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { ProjectBundleStagedEntries, ProjectBundleStagingSink } from "@er-diagram/core";
import type { FastifyInstance } from "fastify";
import { ZipFile } from "yazl";

import { BoundedZipArchiveError, readBoundedZipArchive } from "./bounded-zip-reader.js";
import type { ServerResourceLimits } from "./resource-limits.js";

const FIXED_ZIP_TIMESTAMP = new Date("1980-01-01T00:00:00.000Z");

export type ProjectBundleTransportErrorCode =
  | "PROJECT_BUNDLE_CONTENT_TYPE_UNSUPPORTED"
  | "PROJECT_BUNDLE_ARCHIVE_TOO_LARGE"
  | "PROJECT_BUNDLE_ARCHIVE_INVALID"
  | "PROJECT_BUNDLE_ARCHIVE_RESOURCE_LIMIT_EXCEEDED"
  | "PROJECT_BUNDLE_ARCHIVE_WRITE_FAILED";

export class ProjectBundleTransportError extends Error {
  constructor(
    readonly code: ProjectBundleTransportErrorCode,
    readonly statusCode: 413 | 415 | 422 | 500,
    message: string,
  ) {
    super(message);
    this.name = "ProjectBundleTransportError";
  }
}

export interface StagedProjectBundleUpload {
  readonly filename: string;
  readonly bytes: number;
  cleanup(): Promise<void>;
}

export interface ProjectBundleZipArchive {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  createReadStream(): ReadStream;
}

interface StagedFile {
  readonly filename: string;
  readonly bytes: number;
}

export class FileProjectBundleStaging
  implements ProjectBundleStagingSink, ProjectBundleStagedEntries
{
  readonly #files = new Map<string, StagedFile>();
  #closed = false;

  private constructor(readonly directory: string) {}

  static async create(): Promise<FileProjectBundleStaging> {
    const directory = await mkdtemp(path.join(tmpdir(), "er-diagram-project-bundle-"));
    return new FileProjectBundleStaging(directory);
  }

  async writeEntry(entryPath: string, content: Uint8Array): Promise<void> {
    this.assertOpen();
    if (this.#files.has(entryPath)) {
      throw transportError(
        "PROJECT_BUNDLE_ARCHIVE_INVALID",
        422,
        "The portable bundle contains a duplicate entry.",
      );
    }
    const filename = path.join(
      this.directory,
      `entry-${String(this.#files.size).padStart(6, "0")}-${randomUUID()}.bin`,
    );
    await writeFile(filename, content, { flag: "wx", mode: 0o600 });
    this.#files.set(entryPath, { filename, bytes: content.byteLength });
  }

  async listPaths(): Promise<readonly string[]> {
    this.assertOpen();
    return [...this.#files.keys()].sort(compareCodeUnits);
  }

  async readEntry(entryPath: string): Promise<Uint8Array> {
    this.assertOpen();
    return readFile(this.file(entryPath).filename);
  }

  readEntrySync(entryPath: string): Uint8Array {
    this.assertOpen();
    // Better-sqlite3 transactions are synchronous. Loading is bounded by the
    // already-validated per-entry limit and never uses the logical ZIP path.
    return readFileSync(this.file(entryPath).filename);
  }

  entry(entryPath: string): StagedFile {
    this.assertOpen();
    return this.file(entryPath);
  }

  async cleanup(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await rm(this.directory, { force: true, recursive: true });
  }

  private file(entryPath: string): StagedFile {
    const file = this.#files.get(entryPath);
    if (!file) {
      throw transportError(
        "PROJECT_BUNDLE_ARCHIVE_INVALID",
        422,
        "The portable bundle is missing a staged entry.",
      );
    }
    return file;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Portable bundle staging is closed.");
  }
}

export function registerProjectBundleContentTypeParser(
  server: FastifyInstance,
  limits: ServerResourceLimits,
): void {
  server.addContentTypeParser("application/zip", (request, payload, done) => {
    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > limits.bundle.maxArchiveBytes) {
      payload.resume();
      done(
        transportError(
          "PROJECT_BUNDLE_ARCHIVE_TOO_LARGE",
          413,
          "The portable bundle archive exceeds the configured byte limit.",
        ),
      );
      return;
    }
    void stageBundleUpload(payload, limits.bundle.maxArchiveBytes, contentLength).then(
      (upload) => done(null, upload),
      (error: unknown) => done(error as Error),
    );
  });
}

export function isStagedProjectBundleUpload(value: unknown): value is StagedProjectBundleUpload {
  return (
    typeof value === "object" &&
    value !== null &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    "cleanup" in value &&
    typeof value.cleanup === "function"
  );
}

export async function extractProjectBundleArchive(
  upload: StagedProjectBundleUpload,
  limits: ServerResourceLimits,
): Promise<FileProjectBundleStaging> {
  const staging = await FileProjectBundleStaging.create();
  try {
    const summary = await readBoundedZipArchive(upload.filename, limits.bundle, async (entry) => {
      await staging.writeEntry(entry.path, entry.content);
    });
    if (summary.entryCount !== summary.fileCount) {
      throw transportError(
        "PROJECT_BUNDLE_ARCHIVE_INVALID",
        422,
        "Portable bundles must not contain directory entries.",
      );
    }
    return staging;
  } catch (error) {
    await staging.cleanup();
    throw mapArchiveReadError(error);
  }
}

export async function writeProjectBundleArchive(
  staging: FileProjectBundleStaging,
  limits: ServerResourceLimits,
): Promise<ProjectBundleZipArchive> {
  const archiveFilename = path.join(staging.directory, `bundle-${randomUUID()}.zip`);
  const zip = new ZipFile();
  const paths = await staging.listPaths();
  for (const entryPath of paths) {
    const staged = staging.entry(entryPath);
    zip.addReadStreamLazy(
      entryPath,
      {
        size: staged.bytes,
        mtime: FIXED_ZIP_TIMESTAMP,
        mode: 0o100600,
        compress: true,
        compressionLevel: 6,
        forceDosTimestamp: true,
        fileComment: "",
      },
      (callback) => callback(null, createReadStream(staged.filename)),
    );
  }

  try {
    const output = pipeline(
      zip.outputStream,
      createWriteStream(archiveFilename, { flags: "wx", mode: 0o600 }),
    );
    zip.end({ forceZip64Format: false, comment: "" });
    await output;
    const archiveStats = await stat(archiveFilename);
    if (!archiveStats.isFile() || archiveStats.size > limits.bundle.maxArchiveBytes) {
      throw transportError(
        "PROJECT_BUNDLE_ARCHIVE_TOO_LARGE",
        413,
        "The portable bundle archive exceeds the configured byte limit.",
      );
    }
    return {
      filename: archiveFilename,
      bytes: archiveStats.size,
      sha256: await sha256File(archiveFilename),
      createReadStream: () => createReadStream(archiveFilename),
    };
  } catch (error) {
    if (error instanceof ProjectBundleTransportError) throw error;
    throw transportError(
      "PROJECT_BUNDLE_ARCHIVE_WRITE_FAILED",
      500,
      "The portable bundle archive could not be created.",
    );
  }
}

async function stageBundleUpload(
  payload: NodeJS.ReadableStream,
  maxArchiveBytes: number,
  expectedBytes: number | undefined,
): Promise<StagedProjectBundleUpload> {
  const directory = await mkdtemp(path.join(tmpdir(), "er-diagram-bundle-upload-"));
  const filename = path.join(directory, "upload.zip");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxArchiveBytes - bytes) {
        callback(
          transportError(
            "PROJECT_BUNDLE_ARCHIVE_TOO_LARGE",
            413,
            "The portable bundle archive exceeds the configured byte limit.",
          ),
        );
        return;
      }
      bytes += buffer.length;
      callback(null, buffer);
    },
  });
  try {
    await pipeline(payload, counter, createWriteStream(filename, { flags: "wx", mode: 0o600 }));
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      throw transportError(
        "PROJECT_BUNDLE_ARCHIVE_INVALID",
        422,
        "The portable bundle upload length did not match its header.",
      );
    }
    return {
      filename,
      bytes,
      cleanup: () => rm(directory, { force: true, recursive: true }),
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    if (error instanceof ProjectBundleTransportError) throw error;
    throw transportError(
      "PROJECT_BUNDLE_ARCHIVE_INVALID",
      422,
      "The portable bundle upload could not be read.",
    );
  }
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function mapArchiveReadError(error: unknown): ProjectBundleTransportError {
  if (error instanceof ProjectBundleTransportError) return error;
  if (error instanceof BoundedZipArchiveError) {
    const resourceLimit =
      error.code === "BUNDLE_ARCHIVE_TOO_LARGE" ||
      error.code === "BUNDLE_ARCHIVE_TOO_MANY_ENTRIES" ||
      error.code === "BUNDLE_ARCHIVE_ENTRY_TOO_LARGE" ||
      error.code === "BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE";
    return transportError(
      resourceLimit
        ? "PROJECT_BUNDLE_ARCHIVE_RESOURCE_LIMIT_EXCEEDED"
        : "PROJECT_BUNDLE_ARCHIVE_INVALID",
      resourceLimit ? 413 : 422,
      resourceLimit
        ? "The portable bundle exceeds the configured archive limits."
        : "The portable bundle archive is invalid or unsafe.",
    );
  }
  return transportError(
    "PROJECT_BUNDLE_ARCHIVE_INVALID",
    422,
    "The portable bundle archive is invalid or unsafe.",
  );
}

function transportError(
  code: ProjectBundleTransportErrorCode,
  statusCode: 413 | 415 | 422 | 500,
  message: string,
): ProjectBundleTransportError {
  return new ProjectBundleTransportError(code, statusCode, message);
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
