// The extraction child's answer as JSON: what worker.ts writes on stdout and
// sandbox.ts reads back. The parent validates every answer against these
// schemas, because the child has just parsed a hostile file.

import { z } from 'zod';
import {
  type ExtractOutcome,
  LIMITS,
  type Limits,
  REFUSAL_KINDS,
  SOURCE_TYPES,
} from './types';

const TextPageSchema = z.object({
  page: z.number().int().positive(),
  kind: z.enum(['text', 'scan', 'history']),
  date: z.string().optional(),
  from: z.string().optional(),
  lines: z.array(z.string()),
});

const SourceTextSchema = z.object({
  pages: z.array(TextPageSchema),
  paged: z.boolean(),
  pageTextOnly: z.boolean().optional(),
  originalSender: z.string().optional(),
});

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');

const AttachmentSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  bytes: Base64Schema,
  inline: z.boolean(),
  contentId: z.string().optional(),
  send: z.boolean(),
});

const ForwardedSchema = z.object({
  from: z.string().optional(),
  address: z.string().optional(),
  date: z.string().optional(),
});

const EmailSchema = z.object({
  subject: z.string().optional(),
  from: z.string().optional(),
  fromHeader: z.string().optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  date: z.string().optional(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  threadIds: z.array(z.string()),
  forwarded: ForwardedSchema.optional(),
  attachments: z.array(AttachmentSchema),
});

const ImageSchema = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});

const WireOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      type: z.enum(SOURCE_TYPES),
      mediaType: z.string(),
      text: SourceTextSchema,
      image: ImageSchema.optional(),
      email: EmailSchema.optional(),
      pageCount: z.number().int().positive().optional(),
      notes: z.array(z.string()),
    }),
  }),
  z.object({
    ok: z.literal(false),
    refusal: z.object({ kind: z.enum(REFUSAL_KINDS), reason: z.string() }),
  }),
]);

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64'
  );

/** The outcome as one JSON text, with attachment bytes in base64. */
export function encodeOutcome(outcome: ExtractOutcome): string {
  if (!outcome.ok || !outcome.value.email) return JSON.stringify(outcome);
  const email = outcome.value.email;
  return JSON.stringify({
    ...outcome,
    value: {
      ...outcome.value,
      email: {
        ...email,
        attachments: email.attachments.map((a) => ({
          ...a,
          bytes: base64(a.bytes),
        })),
      },
    },
  });
}

/** Reads the child's JSON answer; undefined when it is not a valid outcome. */
export function decodeOutcome(json: string): ExtractOutcome | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = WireOutcomeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const outcome = parsed.data;
  if (!outcome.ok) return outcome;
  const { email, ...value } = outcome.value;
  if (!email) return { ok: true, value };
  const attachments = email.attachments.map((a) => ({
    ...a,
    bytes: new Uint8Array(Buffer.from(a.bytes, 'base64')),
  }));
  return { ok: true, value: { ...value, email: { ...email, attachments } } };
}

const LimitsSchema = z
  .object({
    maxBytes: z.number().int().positive(),
    pageTextOnlyBytes: z.number().int().positive(),
    pageTextOnlyPages: z.number().int().positive(),
    maxPdfPages: z.number().int().positive(),
    zipEntries: z.number().int().positive(),
    zipUnpackedBytes: z.number().int().positive(),
    maxCells: z.number().int().positive(),
    xmlDepth: z.number().int().positive(),
    xmlElements: z.number().int().positive(),
    imageSide: z.number().int().positive(),
    imageBase64Bytes: z.number().int().positive(),
    inlineImageBytes: z.number().int().nonnegative(),
    scanMinChars: z.number().int().nonnegative(),
    emailDepth: z.number().int().nonnegative(),
    htmlChars: z.number().int().positive(),
  })
  .partial();

/** What the parent tells the child, besides the bytes on stdin. */
export const WorkerRequestSchema = z.object({
  hint: z.object({
    name: z.string().optional(),
    contentType: z.string().optional(),
  }),
  limits: LimitsSchema,
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

/** The limits a request names, on top of the defaults. */
export function requestLimits(request: WorkerRequest): Limits {
  const set = Object.fromEntries(
    Object.entries(request.limits).filter(([, v]) => v !== undefined)
  );
  return { ...LIMITS, ...set };
}
