import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@er-diagram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  BoundedZipArchiveError,
  type BoundedZipArchiveErrorCode,
  type BoundedZipLimits,
  readBoundedZipArchive,
} from "../src/index.js";
import {
  createZipFixture,
  unixExternalFileAttributes,
  type ZipFixtureEntry,
} from "./helpers/zip-fixture.js";

const temporaryDirectories = new Set<string>();
const UNIX_DIRECTORY_MODE = 0o040755;
const UNIX_SYMLINK_MODE = 0o120777;
const UNIX_FIFO_MODE = 0o010644;

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

function limits(overrides: Partial<BoundedZipLimits> = {}): BoundedZipLimits {
  return { ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle, ...overrides };
}

async function writeArchive(entries: readonly ZipFixtureEntry[]): Promise<{
  archive: Buffer;
  filename: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "er-diagram-bounded-zip-"));
  temporaryDirectories.add(directory);
  const filename = join(directory, "bundle.zip");
  const archive = createZipFixture(entries);
  await writeFile(filename, archive);
  return { archive, filename };
}

async function expectArchiveError(
  filename: string,
  expectedCode: BoundedZipArchiveErrorCode,
  archiveLimits: BoundedZipLimits = limits(),
): Promise<BoundedZipArchiveError> {
  try {
    await readBoundedZipArchive(filename, archiveLimits, () => undefined);
  } catch (error) {
    expect(error).toBeInstanceOf(BoundedZipArchiveError);
    expect(error).toMatchObject({ code: expectedCode });
    return error as BoundedZipArchiveError;
  }
  throw new Error(`Expected bounded ZIP failure ${expectedCode}.`);
}

describe("bounded ZIP archive reader", () => {
  it("validates all metadata, skips safe directories, and visits Store/Deflate files sequentially", async () => {
    const { filename } = await writeArchive([
      {
        path: "schema/",
        compressionMethod: 0,
        externalFileAttributes: unixExternalFileAttributes(UNIX_DIRECTORY_MODE) | 0x10,
      },
      { path: "schema/main.dbml", content: "Table café { id int }", compressionMethod: 0 },
      { path: "reports/변환.json", content: '{"status":"EXACT"}' },
    ]);
    const visited: Array<{ path: string; content: string }> = [];
    let activeVisitors = 0;
    let maximumActiveVisitors = 0;

    const summary = await readBoundedZipArchive(filename, limits(), async (entry) => {
      activeVisitors += 1;
      maximumActiveVisitors = Math.max(maximumActiveVisitors, activeVisitors);
      await new Promise((resolve) => setImmediate(resolve));
      visited.push({ path: entry.path, content: entry.content.toString("utf8") });
      activeVisitors -= 1;
    });

    expect(visited).toEqual([
      { path: "schema/main.dbml", content: "Table café { id int }" },
      { path: "reports/변환.json", content: '{"status":"EXACT"}' },
    ]);
    expect(maximumActiveVisitors).toBe(1);
    expect(summary).toEqual({
      entryCount: 3,
      fileCount: 2,
      expandedBytes:
        Buffer.byteLength("Table café { id int }") + Buffer.byteLength('{"status":"EXACT"}'),
    });
  });

  it("does not deliver an earlier file when later central-directory metadata is unsafe", async () => {
    const { filename } = await writeArchive([
      { path: "safe.dbml", content: "Table safe { id int }" },
      { path: "../escape.dbml", content: "secret" },
    ]);
    const visited: string[] = [];

    await expect(
      readBoundedZipArchive(filename, limits(), (entry) => {
        visited.push(entry.path);
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_ARCHIVE_ENTRY_PATH_INVALID" });
    expect(visited).toEqual([]);
  });

  it.each([
    "",
    "/absolute.dbml",
    "//server/share.dbml",
    "C:/drive.dbml",
    "folder\\file.dbml",
    "nul\0.dbml",
    "line\nfeed.dbml",
    "c1\u0085control.dbml",
    "./dot.dbml",
    "folder/./dot.dbml",
    "../parent.dbml",
    "folder/../parent.dbml",
    "folder//empty.dbml",
  ])("rejects non-portable entry path %j", async (path) => {
    const { filename } = await writeArchive([{ path, content: "sentinel" }]);

    await expectArchiveError(filename, "BUNDLE_ARCHIVE_ENTRY_PATH_INVALID");
  });

  it.each([
    ["Schema/main.dbml", "schema/MAIN.dbml"],
    ["café.dbml", "cafe\u0301.dbml"],
    ["straße.dbml", "STRASSE.dbml"],
    ["entry", "entry/"],
  ])("rejects NFC and case-folded portable path collisions", async (first, second) => {
    const entries: ZipFixtureEntry[] = [{ path: first, content: "first" }];
    if (second.endsWith("/")) {
      entries.push({
        path: second,
        compressionMethod: 0,
        externalFileAttributes: unixExternalFileAttributes(UNIX_DIRECTORY_MODE) | 0x10,
      });
    } else {
      entries.push({ path: second, content: "second" });
    }
    const { filename } = await writeArchive(entries);

    await expectArchiveError(filename, "BUNDLE_ARCHIVE_ENTRY_PATH_COLLISION");
  });

  it("rejects encryption, special Unix types, unsafe directories, and unsupported compression", async () => {
    const cases: Array<{
      code: BoundedZipArchiveErrorCode;
      entry: ZipFixtureEntry;
    }> = [
      {
        code: "BUNDLE_ARCHIVE_ENTRY_ENCRYPTED",
        entry: { path: "encrypted.dbml", content: "secret", flags: 1 },
      },
      {
        code: "BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        entry: {
          path: "link.dbml",
          content: "target",
          externalFileAttributes: unixExternalFileAttributes(UNIX_SYMLINK_MODE),
        },
      },
      {
        code: "BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        entry: {
          path: "pipe.dbml",
          externalFileAttributes: unixExternalFileAttributes(UNIX_FIFO_MODE),
        },
      },
      {
        code: "BUNDLE_ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        entry: {
          path: "not-empty/",
          content: "payload",
          compressionMethod: 0,
          externalFileAttributes: unixExternalFileAttributes(UNIX_DIRECTORY_MODE) | 0x10,
        },
      },
      {
        code: "BUNDLE_ARCHIVE_COMPRESSION_UNSUPPORTED",
        entry: { path: "compressed.dbml", content: "source", compressionMethod: 99 },
      },
    ];

    for (const testCase of cases) {
      const { filename } = await writeArchive([testCase.entry]);
      await expectArchiveError(filename, testCase.code);
    }
  });

  it("enforces exact archive and entry-count boundaries before reading entries", async () => {
    const { archive, filename } = await writeArchive([
      {
        path: "empty/",
        compressionMethod: 0,
        externalFileAttributes: unixExternalFileAttributes(UNIX_DIRECTORY_MODE) | 0x10,
      },
      { path: "main.dbml", content: "x", compressionMethod: 0 },
    ]);
    const exactLimits = limits({
      maxArchiveBytes: archive.length,
      maxEntryBytes: 1,
      maxExpandedBytes: archive.length,
      maxEntries: 2,
    });

    await expect(
      readBoundedZipArchive(filename, exactLimits, () => undefined),
    ).resolves.toMatchObject({
      entryCount: 2,
      fileCount: 1,
      expandedBytes: 1,
    });
    await expectArchiveError(
      filename,
      "BUNDLE_ARCHIVE_TOO_LARGE",
      limits({
        maxArchiveBytes: archive.length - 1,
        maxEntryBytes: 1,
        maxExpandedBytes: archive.length,
      }),
    );
    await expectArchiveError(
      filename,
      "BUNDLE_ARCHIVE_TOO_MANY_ENTRIES",
      limits({
        maxArchiveBytes: archive.length,
        maxEntryBytes: 1,
        maxExpandedBytes: archive.length,
        maxEntries: 1,
      }),
    );
  });

  it("enforces declared per-entry and expanded byte budgets", async () => {
    const oversizedEntry = await writeArchive([
      { path: "large.dbml", content: "xx", compressionMethod: 0 },
    ]);
    await expectArchiveError(
      oversizedEntry.filename,
      "BUNDLE_ARCHIVE_ENTRY_TOO_LARGE",
      limits({ maxArchiveBytes: 1024, maxEntryBytes: 1, maxExpandedBytes: 1024 }),
    );

    const expandedArchive = await writeArchive([
      { path: "one.dbml", content: Buffer.alloc(1_600, 0x61) },
      { path: "two.dbml", content: Buffer.alloc(1_600, 0x62) },
    ]);
    await expectArchiveError(
      expandedArchive.filename,
      "BUNDLE_ARCHIVE_EXPANDED_TOO_LARGE",
      limits({ maxArchiveBytes: 3_000, maxEntryBytes: 2_048, maxExpandedBytes: 3_000 }),
    );
  });

  it("enforces actual expansion limits and redacts corrupt ZIP errors", async () => {
    const sentinel = "PRIVATE_ARCHIVE_PATH_SENTINEL";
    const forged = await writeArchive([
      {
        path: `${sentinel}.dbml`,
        content: Buffer.alloc(4_096, 0x61),
        declaredUncompressedSize: 512,
      },
    ]);
    const forgedError = await expectArchiveError(
      forged.filename,
      "BUNDLE_ARCHIVE_ENTRY_TOO_LARGE",
      limits({ maxArchiveBytes: 4_096, maxEntryBytes: 1_024, maxExpandedBytes: 4_096 }),
    );
    expect(forgedError.message).not.toContain(sentinel);
    expect(forgedError.message).not.toContain(forged.filename);

    const sizeMismatch = await writeArchive([
      {
        path: "mismatch.dbml",
        content: Buffer.alloc(1_024, 0x62),
        declaredUncompressedSize: 1_023,
      },
    ]);
    await expectArchiveError(
      sizeMismatch.filename,
      "BUNDLE_ARCHIVE_INVALID",
      limits({ maxArchiveBytes: 2_048, maxEntryBytes: 2_048, maxExpandedBytes: 2_048 }),
    );

    const corruptDirectory = await mkdtemp(join(tmpdir(), "er-diagram-corrupt-zip-"));
    temporaryDirectories.add(corruptDirectory);
    const corruptFilename = join(corruptDirectory, `${sentinel}.zip`);
    await writeFile(corruptFilename, Buffer.from("not a zip archive"));
    const corruptError = await expectArchiveError(corruptFilename, "BUNDLE_ARCHIVE_INVALID");
    expect(corruptError.message).not.toContain(sentinel);
    expect(corruptError.message).not.toContain("end of central directory");
  });

  it("opens only regular files without following symlinks", async () => {
    const { filename } = await writeArchive([{ path: "main.dbml", content: "source" }]);
    const archiveDirectory = dirname(filename);
    await expectArchiveError(archiveDirectory, "BUNDLE_ARCHIVE_NOT_REGULAR_FILE");

    const link = join(archiveDirectory, "bundle-link.zip");
    await symlink(filename, link);
    await expectArchiveError(link, "BUNDLE_ARCHIVE_NOT_REGULAR_FILE");
  });

  it("closes the archive after a visitor failure and preserves the visitor error", async () => {
    const { filename } = await writeArchive([{ path: "main.dbml", content: "source" }]);
    const visitorError = new Error("consumer rejected staged entry");

    await expect(
      readBoundedZipArchive(filename, limits(), () => {
        throw visitorError;
      }),
    ).rejects.toBe(visitorError);

    await expect(writeFile(filename, createZipFixture([]))).resolves.toBeUndefined();
    await expect(readBoundedZipArchive(filename, limits(), () => undefined)).resolves.toEqual({
      entryCount: 0,
      fileCount: 0,
      expandedBytes: 0,
    });
  });
});
