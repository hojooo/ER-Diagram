import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  readonly path: string;
  readonly content?: string | Buffer;
  readonly compressionMethod?: number;
  readonly flags?: number;
  readonly versionMadeBy?: number;
  readonly externalFileAttributes?: number;
  readonly declaredCompressedSize?: number;
  readonly declaredUncompressedSize?: number;
}

interface EncodedEntry {
  readonly path: Buffer;
  readonly compressed: Buffer;
  readonly compressionMethod: number;
  readonly flags: number;
  readonly versionMadeBy: number;
  readonly externalFileAttributes: number;
  readonly declaredCompressedSize: number;
  readonly declaredUncompressedSize: number;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION_2 = 20;
const UNIX_VERSION_MADE_BY = (3 << 8) | ZIP_VERSION_2;
const UNIX_REGULAR_FILE_MODE = 0o100644;

export function createZipFixture(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const encodedEntries: EncodedEntry[] = [];
  let localHeaderOffset = 0;

  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? "", "utf8");
    const compressionMethod = entry.compressionMethod ?? 8;
    const compressed = compressionMethod === 8 ? deflateRawSync(content) : content;
    const declaredCompressedSize = entry.declaredCompressedSize ?? compressed.length;
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? content.length;
    const flags = (entry.flags ?? 0) | 0x0800;
    const externalFileAttributes =
      entry.externalFileAttributes ?? (UNIX_REGULAR_FILE_MODE << 16) >>> 0;
    const encoded: EncodedEntry = {
      path,
      compressed,
      compressionMethod,
      flags,
      versionMadeBy: entry.versionMadeBy ?? UNIX_VERSION_MADE_BY,
      externalFileAttributes,
      declaredCompressedSize,
      declaredUncompressedSize,
      crc: crc32(content),
      localHeaderOffset,
    };
    encodedEntries.push(encoded);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(ZIP_VERSION_2, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(compressionMethod, 8);
    header.writeUInt32LE(encoded.crc, 14);
    header.writeUInt32LE(declaredCompressedSize, 18);
    header.writeUInt32LE(declaredUncompressedSize, 22);
    header.writeUInt16LE(path.length, 26);
    localParts.push(header, path, compressed);
    localHeaderOffset += header.length + path.length + compressed.length;
  }

  const centralParts = encodedEntries.map((entry) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(entry.versionMadeBy, 4);
    header.writeUInt16LE(ZIP_VERSION_2, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.compressionMethod, 10);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.declaredCompressedSize, 20);
    header.writeUInt32LE(entry.declaredUncompressedSize, 24);
    header.writeUInt16LE(entry.path.length, 28);
    header.writeUInt32LE(entry.externalFileAttributes >>> 0, 38);
    header.writeUInt32LE(entry.localHeaderOffset, 42);
    return Buffer.concat([header, entry.path]);
  });
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localHeaderOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function unixExternalFileAttributes(mode: number): number {
  return (mode << 16) >>> 0;
}
