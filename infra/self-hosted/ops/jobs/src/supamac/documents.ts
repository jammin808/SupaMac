// Documents in SupaMac: originals and their text uploaded to the Job sources
// folder, the Job intake folder listed, a document moved, and the web links
// the service hands out (docs/supamac/jobs.md, §1, §2, Asking).
//
// Invariants:
// - An upload's file name is a single name, never a path: directory parts,
//   control characters, NUL and unpaired surrogates are removed, and it keeps
//   an allowed extension. A `.docx` is never uploaded (it never becomes ready
//   on this stack); its text document is uploaded instead.
// - An upload is at most 25 MiB (`MAX_UPLOAD_BYTES`), checked before sending.
// - A Markdown text is uploaded as a `.md` file, which SupaMac makes a
//   native Markdown document.
// - A download fetches the stored bytes through the gateway's object store
//   path, never with the API key, and stops at the size it was given.
// - Links are built from the configured web app URL: its origin and the path
//   the app is served from (`/app` when it names none, as the SDK reads it).
//   A PDF page link is 1-based (apps/web/src/features/block-pdf reads
//   `pdf_page_number` below 1 as no location) and carries `pdf_page_y=0`,
//   without which the viewer ignores the page.

import { stripUnsafe } from '../normalize';
import {
  checkId,
  type DocumentContentState,
  exportDocumentRequest,
  getDocumentRequest,
  moveDocumentRequest,
  projectContentRequest,
  uploadFileRequest,
} from './api';
import { type SupaMacClient, SupaMacError } from './client';

/** The upload route's limit: 25 MiB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Document names are at most 200 graphemes; a name is cut well below that. */
const MAX_NAME_CHARS = 150;
/** The longest extension a shortened text document name keeps. */
const MAX_EXTENSION_CHARS = 8;

/**
 * The file types the service stores as originals (design §2's allow-list,
 * less `.docx`), and `md` for its own text documents.
 */
export const UPLOAD_EXTENSIONS = [
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'xlsx',
  'csv',
  'ics',
  'md',
] as const;
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

export type DocumentErrorKind =
  | 'bad_name'
  | 'type_refused'
  | 'too_large'
  | 'empty'
  | 'bad_link';

export class DocumentError extends Error {
  readonly kind: DocumentErrorKind;
  constructor(kind: DocumentErrorKind, message: string) {
    super(message);
    this.name = 'DocumentError';
    this.kind = kind;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * A file name SupaMac takes: one name with an allowed extension. Directory
 * parts and control characters go; a long name is shortened before its
 * extension; a leading dot goes.
 */
export function sanitizeFileName(raw: string): string {
  const base = stripUnsafe(raw).split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/\s+/g, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  const extension = extensionOf(cleaned);
  if (extension === 'docx') {
    throw new DocumentError(
      'type_refused',
      'a .docx is never uploaded: its text document is'
    );
  }
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new DocumentError(
      'type_refused',
      `a .${extension || '(none)'} file is not one the service stores`
    );
  }
  const stem = cleaned
    .slice(0, cleaned.length - extension.length - 1)
    .trim()
    .replace(/[.\s]+$/, '');
  if (stem === '')
    throw new DocumentError(
      'bad_name',
      'the file name has no name before its extension'
    );
  const chars = [...stem];
  const short =
    chars.length > MAX_NAME_CHARS
      ? `${chars.slice(0, MAX_NAME_CHARS).join('').trimEnd()}…`
      : stem;
  return `${short}.${extension}`;
}

export interface Uploaded {
  readonly documentId: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

/** Uploads a file's bytes into a folder. */
export async function uploadFile(
  client: SupaMacClient,
  input: {
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly folderId: string;
  }
): Promise<Uploaded> {
  const fileName = sanitizeFileName(input.fileName);
  if (input.bytes.byteLength === 0)
    throw new DocumentError('empty', 'an upload needs some bytes');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new DocumentError(
      'too_large',
      `the file is over ${MAX_UPLOAD_BYTES} bytes`
    );
  }
  const answer = await client.send(
    uploadFileRequest(fileName, input.bytes, input.folderId)
  );
  return {
    documentId: answer.documentId,
    sizeBytes: answer.sizeBytes,
    fileName,
  };
}

/**
 * Uploads Markdown as a native Markdown document named `name` (the `.md`
 * extension is added), such as `Call sheet.pdf · text`.
 */
export async function uploadMarkdown(
  client: SupaMacClient,
  input: {
    readonly name: string;
    readonly markdown: string;
    readonly folderId: string;
  }
): Promise<Uploaded> {
  const bytes = new TextEncoder().encode(stripUnsafe(input.markdown));
  return uploadFile(client, {
    fileName: `${input.name}.md`,
    bytes,
    folderId: input.folderId,
  });
}

const TEXT_SUFFIX = ' · text';

/**
 * The text document's name for an original: `<file> · text`. The file part
 * is the original's own name (its last path part); when the whole would be
 * longer than an upload name may be, the file's stem is shortened, keeping
 * its extension and the suffix, so the name still ends in ` · text` and never
 * reads as the original's.
 */
export function textDocumentName(originalName: string): string {
  const file = (stripUnsafe(originalName).split(/[\\/]/).pop() ?? '').trim();
  const chars = [...file];
  if (chars.length + TEXT_SUFFIX.length <= MAX_NAME_CHARS)
    return `${file}${TEXT_SUFFIX}`;
  const extension = extensionOf(file);
  // An extension too long to be one is cut with the rest of the name.
  const tail =
    extension === '' || extension.length > MAX_EXTENSION_CHARS
      ? ''
      : `.${extension}`;
  const room = MAX_NAME_CHARS - TEXT_SUFFIX.length - tail.length - 1;
  const stem = chars
    .slice(0, chars.length - tail.length)
    .slice(0, room)
    .join('')
    .trimEnd();
  return `${stem}…${tail}${TEXT_SUFFIX}`;
}

export type Readiness = DocumentContentState;

export interface FolderDocument {
  readonly id: string;
  readonly name: string;
  /** The owner's Macro user id (`macro|<email>`). */
  readonly owner: string;
  readonly fileType: string | undefined;
  readonly createdAt: string | undefined;
  /** Whether its bytes are stored; only read when asked for. */
  readonly readiness?: Readiness | undefined;
}

function readinessOf(state: string): Readiness {
  return state === 'ready' || state === 'pending' ? state : 'unknown';
}

/**
 * The documents directly in a folder, not trashed, with their owners; with
 * `readiness`, each document's content state too (one request each).
 */
export async function listFolderDocuments(
  client: SupaMacClient,
  folderId: string,
  options: { readonly readiness?: boolean } = {}
): Promise<FolderDocument[]> {
  const answer = await client.send(projectContentRequest(folderId));
  const out: FolderDocument[] = [];
  for (const { item } of answer.data) {
    if (!('owner' in item) || (item.deletedAt ?? null) !== null) continue;
    const doc: FolderDocument = {
      id: item.id,
      name: item.name,
      owner: item.owner,
      fileType: item.fileType ?? undefined,
      createdAt: item.createdAt ?? undefined,
    };
    if (options.readiness === true) {
      const info = await documentInfo(client, item.id);
      out.push({ ...doc, readiness: info.readiness });
    } else {
      out.push(doc);
    }
  }
  return out;
}

export interface DocumentInfo {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly fileType: string | undefined;
  readonly folderId: string | undefined;
  readonly trashed: boolean;
  readonly readiness: Readiness;
}

export async function documentInfo(
  client: SupaMacClient,
  documentId: string
): Promise<DocumentInfo> {
  const answer = await client.send(getDocumentRequest(documentId));
  const meta = answer.data.documentMetadata;
  return {
    id: meta.documentId,
    name: meta.documentName,
    owner: meta.owner,
    fileType: meta.fileType ?? undefined,
    folderId: meta.projectId ?? undefined,
    trashed: (meta.deletedAt ?? null) !== null,
    readiness: readinessOf(meta.content.state),
  };
}

/** Moves a document into a folder, such as from Job intake to Job sources. */
export async function moveDocument(
  client: SupaMacClient,
  documentId: string,
  folderId: string
): Promise<void> {
  const answer = await client.send(moveDocumentRequest(documentId, folderId));
  if (!answer.data.success) {
    throw new SupaMacError(
      'server',
      'PATCH /documents/{document_id}',
      'the move was not made'
    );
  }
}

/** A stored document's bytes, at most `maxBytes` (25 MiB unless given). */
export async function downloadDocument(
  client: SupaMacClient,
  documentId: string,
  options: { readonly maxBytes?: number } = {}
): Promise<Uint8Array> {
  const answer = await client.send(exportDocumentRequest(documentId));
  return client.fetchObject(answer.presigned_url, {
    maxBytes: options.maxBytes ?? MAX_UPLOAD_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Web links.

export interface WebAppBase {
  readonly origin: string;
  readonly basePath: string;
}

/** The app's origin and the path it is served from (`/app` when the URL names none). */
export function webAppBase(webAppUrl: string): WebAppBase {
  let url: URL;
  try {
    url = new URL(webAppUrl);
  } catch {
    throw new DocumentError('bad_link', 'the web app URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DocumentError(
      'bad_link',
      'the web app URL must be http or https'
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, basePath: path === '' ? '/app' : path };
}

function link(
  base: WebAppBase,
  path: string,
  query: Readonly<Record<string, string>> = {}
): string {
  const url = new URL(`${base.origin}${base.basePath}${path}`);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return url.toString();
}

/** The database, opened on a table and view when they are given. */
export function databaseLink(
  base: WebAppBase,
  databaseId: string,
  options: {
    readonly tableId?: string | undefined;
    readonly viewId?: string | undefined;
  } = {}
): string {
  const query: Record<string, string> = {};
  if (options.tableId !== undefined)
    query.tableId = checkId('table id', options.tableId);
  if (options.viewId !== undefined) {
    if (options.tableId === undefined)
      throw new DocumentError('bad_link', 'a view link names its table');
    query.viewId = checkId('view id', options.viewId);
  }
  return link(base, `/database/${checkId('database id', databaseId)}`, query);
}

/** A PDF opened at a page, counted from 1. */
export function pdfPageLink(
  base: WebAppBase,
  documentId: string,
  page?: number
): string {
  if (page === undefined)
    return link(base, `/pdf/${checkId('document id', documentId)}`);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new DocumentError('bad_link', 'a PDF page is a whole number from 1');
  }
  return link(base, `/pdf/${checkId('document id', documentId)}`, {
    pdf_page_number: String(page),
    pdf_page_y: '0',
  });
}

/** A Markdown document. */
export function markdownLink(base: WebAppBase, documentId: string): string {
  return link(base, `/md/${checkId('document id', documentId)}`);
}
