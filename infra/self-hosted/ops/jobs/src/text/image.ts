// Images (docs/supamac/jobs.md §2): no text; the model reads them, so every
// detail from one needs review. This module only checks what an image is and
// whether the model accepts it.
//
// Invariants:
// - The type is the one the magic number names; image-size must read the same
//   type from the same bytes, or the image is refused as damaged.
// - An image wider or taller than `imageSide` pixels, or whose base64 form is
//   over `imageBase64Bytes`, is refused with the reason, never resized or sent.

import { imageSize } from 'image-size';
import {
  ExtractError,
  type ImageInfo,
  type ImageMediaType,
  type ImageType,
  type Limits,
  sizeText,
} from './types';
import { errorText } from './zip';

const MEDIA: Readonly<Record<ImageType, ImageMediaType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** image-size's name for each type. */
const SIZE_TYPE: Readonly<Record<ImageType, string>> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Checks an image the sniffer named, and returns what the model request needs. */
export function inspectImage(
  bytes: Uint8Array,
  type: ImageType,
  limits: Limits
): ImageInfo {
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(bytes);
  } catch (error) {
    throw new ExtractError(
      'damaged',
      `The image cannot be read (${errorText(error)}).`
    );
  }
  if (size.type !== SIZE_TYPE[type]) {
    throw new ExtractError(
      'damaged',
      `The image says it is ${type} but does not read as one.`
    );
  }

  const portrait =
    size.orientation !== undefined &&
    size.orientation >= 5 &&
    size.orientation <= 8;
  const width = portrait ? size.height : size.width;
  const height = portrait ? size.width : size.height;
  if (!(width > 0 && height > 0)) {
    throw new ExtractError('damaged', 'The image has no width or height.');
  }
  if (width > limits.imageSide || height > limits.imageSide) {
    throw new ExtractError(
      'image_dimensions',
      `The image is ${width} × ${height} pixels; the model reads images up to ${limits.imageSide} pixels on each side. Send a smaller copy or a screenshot.`
    );
  }
  if (base64Length(bytes.length) > limits.imageBase64Bytes) {
    throw new ExtractError(
      'image_bytes',
      `The image is ${sizeText(bytes.length)}; the model reads images up to about ${sizeText(Math.floor((limits.imageBase64Bytes * 3) / 4))}. Send a smaller copy or a screenshot.`
    );
  }
  return { mediaType: MEDIA[type], width, height, bytes: bytes.length };
}
