import { describe, expect, test } from 'bun:test';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { ExtractError, LIMITS } from '../../src/text/types';
import { crc32, openZip } from '../../src/text/zip';
import { deflated, rawZip } from './build';

function refusal(run: () => unknown): ExtractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExtractError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('openZip', () => {
  test('reads entries by name, case-insensitively, inflating only what is asked for', () => {
    const zip = openZip(
      zipSync({
        'word/document.xml': strToU8('<w:document/>'),
        'media/logo.png': new Uint8Array(1000),
      }),
      LIMITS
    );
    expect(zip.size).toBe(2);
    expect(zip.has('WORD/Document.xml')).toBe(true);
    expect(zip.readText('word/document.xml')).toBe('<w:document/>');
    expect(zip.unpacked).toBe(13);
    expect(zip.read('missing.xml')).toBeUndefined();
  });

  test('reads stored entries and checks their checksum', () => {
    const data = strToU8('Crew call 07:00');
    const zip = openZip(
      rawZip([
        { name: 'a.txt', data, method: 0, size: data.length, crc: crc32(data) },
      ]),
      LIMITS
    );
    expect(zip.readText('a.txt')).toBe('Crew call 07:00');

    const bad = openZip(
      rawZip([{ name: 'a.txt', data, method: 0, size: data.length, crc: 1 }]),
      LIMITS
    );
    expect(refusal(() => bad.read('a.txt')).kind).toBe('damaged');
  });

  test('refuses an archive of more than 500 entries before inflating anything', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 501; i++) files[`part${i}.xml`] = strToU8('<a/>');
    const error = refusal(() => openZip(zipSync(files), LIMITS));
    expect(error.kind).toBe('zip_entries');
    expect(error.message).toContain('more than 500');
  });

  test('stops a zip bomb within one slice of the 50 MB cap, counted while inflating', () => {
    const big = new Uint8Array(60_000_000);
    const zip = openZip(
      rawZip([deflated('xl/worksheets/sheet1.xml', big)]),
      LIMITS
    );
    const error = refusal(() => zip.read('xl/worksheets/sheet1.xml'));
    expect(error.kind).toBe('zip_unpacked');
    expect(zip.unpacked).toBeGreaterThan(50_000_000);
    expect(zip.unpacked).toBeLessThan(50_000_000 + 9_000_000);
  });

  test('stops an entry that inflates past the size it declares', () => {
    const big = new Uint8Array(20_000_000);
    const lying = {
      name: 'word/document.xml',
      data: deflateSync(big),
      method: 8,
      size: 1000,
      crc: 0,
    };
    const zip = openZip(rawZip([lying]), LIMITS);
    const error = refusal(() => zip.read('word/document.xml'));
    expect(error.kind).toBe('damaged');
    expect(error.message).toContain('larger than it declares');
    expect(zip.unpacked).toBeLessThan(9_000_000);
  });

  test('counts every entry read against one budget', () => {
    const half = new Uint8Array(30_000_000);
    const zip = openZip(
      rawZip([deflated('a.xml', half), deflated('b.xml', half)]),
      LIMITS
    );
    expect(zip.read('a.xml')?.length).toBe(30_000_000);
    expect(refusal(() => zip.read('b.xml')).kind).toBe('zip_unpacked');
  });

  test('refuses truncated, encrypted and duplicate-name archives and unknown methods', () => {
    const good = zipSync({ 'a.xml': strToU8('<a>hello</a>') });
    expect(
      refusal(() => openZip(good.subarray(0, good.length - 30), LIMITS)).kind
    ).toBe('damaged');

    const data = strToU8('secret');
    const encrypted = openZip(
      rawZip([
        { name: 'a.xml', data, method: 0, size: 6, crc: crc32(data), flags: 1 },
      ]),
      LIMITS
    );
    expect(refusal(() => encrypted.read('a.xml')).kind).toBe('encrypted');

    const twice = rawZip([
      deflated('word/document.xml', data),
      deflated('WORD/document.xml', data),
    ]);
    expect(refusal(() => openZip(twice, LIMITS)).message).toContain('twice');

    const bzip = openZip(
      rawZip([{ name: 'a.xml', data, method: 12, size: 6, crc: crc32(data) }]),
      LIMITS
    );
    expect(refusal(() => bzip.read('a.xml')).message).toContain('method 12');

    const cut = rawZip([deflated('a.xml', strToU8('<a>'.repeat(1000)))]);
    const broken = cut.slice();
    broken.fill(0xff, 40, 60);
    expect(refusal(() => openZip(broken, LIMITS).read('a.xml')).kind).toBe(
      'damaged'
    );
  });
});
