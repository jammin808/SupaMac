// A capped reader of zip archives, for the zip-based files on the allow-list
// (docx, xlsx; docs/supamac/jobs.md §2).
//
// Invariants:
// - The central directory is read first. An archive with more than
//   `zipEntries` entries is refused before anything is inflated.
// - An entry is inflated only when it is asked for, in small slices, and every
//   inflated byte counts against one budget for the whole archive, so an entry
//   whose real size exceeds what it declares (a zip bomb) is stopped within
//   one slice of the cap, never held whole in memory.
// - An inflated entry must have exactly its declared size and CRC-32, or the
//   archive is refused as damaged.
// - Part names are compared case-insensitively (OPC); two entries with the
//   same name are refused, so no reader can be shown a different part from
//   another reader's.
// - Encrypted entries, ZIP64 archives, and methods other than stored and
//   deflate are refused, never guessed at.

import { Inflate } from 'fflate';
import { ExtractError, type Limits } from './types';

/** Compressed bytes fed to the inflater per step: at most ~8 MB of output each. */
const SLICE = 8 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc =
      (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function damaged(what: string): ExtractError {
  return new ExtractError(
    'damaged',
    `The file is not a readable archive: ${what}.`
  );
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Without the UTF-8 flag names are CP437; OOXML part names are ASCII.
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export class ZipArchive {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #entries: Map<string, ZipEntry>;
  readonly #limits: Pick<Limits, 'zipEntries' | 'zipUnpackedBytes'>;
  #unpacked = 0;

  constructor(
    bytes: Uint8Array,
    limits: Pick<Limits, 'zipEntries' | 'zipUnpackedBytes'>
  ) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#limits = limits;
    this.#entries = this.#readDirectory();
  }

  /** Every entry name as the archive writes it. */
  get names(): string[] {
    return [...this.#entries.values()].map((e) => e.name);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Bytes inflated so far, across all entries read. */
  get unpacked(): number {
    return this.#unpacked;
  }

  has(name: string): boolean {
    return this.#entries.has(name.toLowerCase());
  }

  entry(name: string): ZipEntry | undefined {
    return this.#entries.get(name.toLowerCase());
  }

  /** The entry's bytes, or undefined when there is no such entry. */
  read(name: string): Uint8Array | undefined {
    const entry = this.entry(name);
    if (!entry) return undefined;
    return this.#inflate(entry);
  }

  /** The entry as UTF-8 text without a byte order mark. */
  readText(name: string): string | undefined {
    const bytes = this.read(name);
    if (!bytes) return undefined;
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  #u16(at: number): number {
    if (at < 0 || at + 2 > this.#bytes.length) throw damaged('it is cut short');
    return this.#view.getUint16(at, true);
  }

  #u32(at: number): number {
    if (at < 0 || at + 4 > this.#bytes.length) throw damaged('it is cut short');
    return this.#view.getUint32(at, true);
  }

  #findEnd(): number {
    const bytes = this.#bytes;
    const last = bytes.length - 22;
    const first = Math.max(0, last - 0xffff);
    for (let i = last; i >= first; i--) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x05 &&
        bytes[i + 3] === 0x06 &&
        this.#u32(i) === EOCD
      ) {
        return i;
      }
    }
    throw damaged('it has no end of central directory');
  }

  #readDirectory(): Map<string, ZipEntry> {
    if (this.#bytes.length < 22) throw damaged('it is too short');
    const end = this.#findEnd();
    const declared = this.#u16(end + 10);
    const cdSize = this.#u32(end + 12);
    const cdOffset = this.#u32(end + 16);
    const zip64 =
      declared === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff ||
      (end >= 20 && this.#u32(end - 20) === ZIP64_LOCATOR);
    if (zip64) {
      throw new ExtractError(
        'damaged',
        'The file is a ZIP64 archive, which is not read; save it again from its application.'
      );
    }
    if (declared > this.#limits.zipEntries)
      throw tooManyEntries(declared, this.#limits.zipEntries);
    if (cdOffset + cdSize > end)
      throw damaged('its directory points past its end');
    const entries = new Map<string, ZipEntry>();
    let at = cdOffset;
    let count = 0;
    while (at < cdOffset + cdSize) {
      if (this.#u32(at) !== CENTRAL) throw damaged('its directory is broken');
      count++;
      if (count > this.#limits.zipEntries)
        throw tooManyEntries(count, this.#limits.zipEntries);
      const flags = this.#u16(at + 8);
      const method = this.#u16(at + 10);
      const crc = this.#u32(at + 16);
      const compressedSize = this.#u32(at + 20);
      const size = this.#u32(at + 24);
      const nameLength = this.#u16(at + 28);
      const extraLength = this.#u16(at + 30);
      const commentLength = this.#u16(at + 32);
      const offset = this.#u32(at + 42);
      const nameStart = at + 46;
      if (nameStart + nameLength > this.#bytes.length)
        throw damaged('an entry name is cut short');
      const name = decodeName(
        this.#bytes.subarray(nameStart, nameStart + nameLength),
        (flags & 0x0800) !== 0
      );
      const key = name.toLowerCase();
      if (entries.has(key)) {
        throw new ExtractError(
          'damaged',
          `The file's archive names "${name.slice(0, 80)}" twice, so it is not read.`
        );
      }
      entries.set(key, {
        name,
        method,
        flags,
        crc,
        compressedSize,
        size,
        offset,
      });
      at = nameStart + nameLength + extraLength + commentLength;
    }
    if (count !== declared)
      throw damaged('its entry count does not match its directory');
    return entries;
  }

  #count(n: number): void {
    this.#unpacked += n;
    if (this.#unpacked > this.#limits.zipUnpackedBytes) {
      throw new ExtractError(
        'zip_unpacked',
        `The file unpacks to more than ${Math.round(this.#limits.zipUnpackedBytes / 1_000_000)} MB, so it is not read.`
      );
    }
  }

  #inflate(entry: ZipEntry): Uint8Array {
    if (entry.flags & 0x0001) {
      throw new ExtractError(
        'encrypted',
        'The file is encrypted, so it cannot be read.'
      );
    }
    if (entry.name.endsWith('/')) return new Uint8Array(0);
    const local = entry.offset;
    if (this.#u32(local) !== LOCAL)
      throw damaged(`"${entry.name}" has no local header`);
    const dataStart =
      local + 30 + this.#u16(local + 26) + this.#u16(local + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.#bytes.length)
      throw damaged(`"${entry.name}" is cut short`);
    const data = this.#bytes.subarray(dataStart, dataEnd);
    let out: Uint8Array;
    if (entry.method === 0) {
      this.#count(data.length);
      out = data.slice();
    } else if (entry.method === 8) {
      out = this.#inflateDeflate(entry, data);
    } else {
      throw new ExtractError(
        'damaged',
        `The file's archive uses compression method ${entry.method}, which is not read.`
      );
    }
    if (out.length !== entry.size) {
      throw damaged(`"${entry.name}" is not the size it declares`);
    }
    if (crc32(out) !== entry.crc)
      throw damaged(`"${entry.name}" fails its checksum`);
    return out;
  }

  #inflateDeflate(entry: ZipEntry, data: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      this.#count(chunk.length);
      length += chunk.length;
      if (length > entry.size) {
        throw damaged(`"${entry.name}" is larger than it declares`);
      }
      chunks.push(chunk.slice());
      if (final) finished = true;
    });
    try {
      if (data.length === 0) inflater.push(new Uint8Array(0), true);
      for (let i = 0; i < data.length; i += SLICE) {
        const last = i + SLICE >= data.length;
        inflater.push(data.subarray(i, Math.min(i + SLICE, data.length)), last);
      }
    } catch (error) {
      if (error instanceof ExtractError) throw error;
      throw damaged(`"${entry.name}" does not inflate (${errorText(error)})`);
    }
    if (!finished && length < entry.size)
      throw damaged(`"${entry.name}" is cut short`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function tooManyEntries(count: number, limit: number): ExtractError {
  return new ExtractError(
    'zip_entries',
    `The file's archive has ${count > limit ? `more than ${limit}` : count} entries, so it is not read.`
  );
}

export function errorText(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 200);
  return String(error).slice(0, 200);
}

/** Whether the bytes start like a zip archive (a local header or an empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

export function openZip(
  bytes: Uint8Array,
  limits: Pick<Limits, 'zipEntries' | 'zipUnpackedBytes'>
): ZipArchive {
  return new ZipArchive(bytes, limits);
}
