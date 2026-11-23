import { describe, expect, test } from 'bun:test';
import { extract } from '../../src/text/extract';
import { base64Length } from '../../src/text/image';
import { REFUSAL_STATUS } from '../../src/text/types';
import { concat, ftyp, gif, jpeg, png } from './build';

describe('images', () => {
  test('are one scan page with their type and size for the model', async () => {
    const outcome = await extract(png(1200, 800), { name: 'call-sheet.jpg' });
    if (!outcome.ok) throw new Error(outcome.refusal.reason);
    expect(outcome.value.type).toBe('png');
    expect(outcome.value.image).toEqual({
      mediaType: 'image/png',
      width: 1200,
      height: 800,
      bytes: outcome.value.image?.bytes ?? 0,
    });
    expect(outcome.value.text).toEqual({
      paged: false,
      pages: [{ page: 1, kind: 'scan', lines: [] }],
    });

    const photo = await extract(jpeg(4032, 3024));
    expect(photo.ok && photo.value.image).toMatchObject({
      mediaType: 'image/jpeg',
      width: 4032,
      height: 3024,
    });
  });

  test('a GIF is not on the allow-list, so it is refused as unsupported', async () => {
    const anim = await extract(gif(320, 240), { name: 'flyer.gif' });
    expect(!anim.ok && anim.refusal.kind).toBe('unsupported_type');
    expect(!anim.ok && anim.refusal.reason).toContain('a GIF image');
  });

  test('over 8000 pixels on a side, or over 5 MB in base64, are refused with the reason', async () => {
    const wide = await extract(png(9000, 100));
    expect(!wide.ok && wide.refusal).toMatchObject({
      kind: 'image_dimensions',
    });
    expect(!wide.ok && wide.refusal.reason).toContain('9000 × 100');

    const heavy = await extract(
      concat([png(2000, 2000), new Uint8Array(4_000_000)])
    );
    expect(base64Length(4_000_045)).toBeGreaterThan(5 * 1024 * 1024);
    expect(!heavy.ok && heavy.refusal.kind).toBe('image_bytes');
  });

  test('HEIC is refused with how to send it instead; AVIF and broken images are refused', async () => {
    const heic = await extract(ftyp('heic'), { name: 'IMG_0001.HEIC' });
    expect(!heic.ok && heic.refusal.kind).toBe('heic');
    expect(!heic.ok && heic.refusal.reason).toContain('JPEG');
    expect(REFUSAL_STATUS.heic).toBe('Skipped');

    const avif = await extract(ftyp('avif'));
    expect(!avif.ok && avif.refusal.kind).toBe('unsupported_type');

    const broken = png(100, 100).slice(0, 12);
    expect((await extract(broken)).ok).toBe(false);
  });
});
