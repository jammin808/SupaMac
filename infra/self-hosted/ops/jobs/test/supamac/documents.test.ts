import { beforeAll, describe, expect, test } from 'bun:test';
import { SupaMacClient, SupaMacError } from '../../src/supamac/client';
import {
  databaseLink,
  DocumentError,
  type DocumentErrorKind,
  documentInfo,
  downloadDocument,
  listFolderDocuments,
  markdownLink,
  MAX_UPLOAD_BYTES,
  moveDocument,
  pdfPageLink,
  sanitizeFileName,
  textDocumentName,
  uploadFile,
  uploadMarkdown,
  webAppBase,
} from '../../src/supamac/documents';
import { ensureJobsSchema } from '../../src/supamac/schema';
import type { JobsSchema } from '../../src/supamac/tables';
import {
  BASE,
  FakeDss,
  OWNER_EMAIL,
  OWNER_USER,
  SERVICE_USER,
} from './fake-dss';

const KEY = ['mak', 'd4'.repeat(32)].join('_');
const DB = '0190d5a8-0000-7000-a000-0000000000db';
const TABLE = '0190d5a8-0000-7000-a000-0000000000ab';
const VIEW = '0190d5a8-0000-7000-a000-0000000000cd';
const DOC = '0190d5a8-0000-7000-a000-0000000000ef';

function documentError(fn: () => unknown, kind: DocumentErrorKind): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} DocumentError`);
}

async function rejects(
  promise: Promise<unknown>,
  kind: DocumentErrorKind
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} DocumentError`);
}

describe('file names', () => {
  test('keep one name with its extension', () => {
    expect(sanitizeFileName('Call sheet - Acme Productions.PDF')).toBe(
      'Call sheet - Acme Productions.pdf'
    );
    expect(sanitizeFileName('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFileName('C:\\Users\\crew\\PO 4500123.xlsx')).toBe(
      'PO 4500123.xlsx'
    );
    expect(
      sanitizeFileName('  Example\u0000 Hotel\u202e\tconfirmation .jpg ')
    ).toBe('Example Hotel confirmation.jpg');
    expect(sanitizeFileName('...hidden.png')).toBe('hidden.png');
    expect(sanitizeFileName('Call sheet.pdf · text.md')).toBe(
      'Call sheet.pdf · text.md'
    );
    expect(sanitizeFileName('x\ud83c.csv')).toBe('x.csv');
  });

  test('shorten a long name before its extension', () => {
    const name = sanitizeFileName(`${'Production pack '.repeat(30)}.pdf`);
    expect([...name].length).toBeLessThanOrEqual(160);
    expect(name.endsWith('….pdf')).toBe(true);
  });

  test('refuse a .docx, an unknown type and a name with nothing before the extension', () => {
    documentError(
      () => sanitizeFileName('Production pack.docx'),
      'type_refused'
    );
    documentError(() => sanitizeFileName('invoice.exe'), 'type_refused');
    documentError(() => sanitizeFileName('noextension'), 'type_refused');
    documentError(() => sanitizeFileName('/tmp/.pdf'), 'type_refused');
    documentError(() => sanitizeFileName('  .pdf'), 'type_refused');
    documentError(() => sanitizeFileName('\u0000.pdf'), 'type_refused');
    documentError(
      () => sanitizeFileName('-.pdf'.replace('-', ' ')),
      'type_refused'
    );
  });

  test('a text document is named after its original', () => {
    expect(textDocumentName('Call sheet.pdf')).toBe('Call sheet.pdf · text');
    expect(textDocumentName('C:\\Users\\crew/PO 4500123.xlsx')).toBe(
      'PO 4500123.xlsx · text'
    );
  });

  test("a long original's text document is shortened before the extension and keeps ' · text'", () => {
    const original = sanitizeFileName(
      `${'Acme Productions production pack '.repeat(6)}rev 3.pdf`
    );
    const name = textDocumentName(original);
    expect(name.endsWith('….pdf · text')).toBe(true);
    expect([...name].length).toBeLessThanOrEqual(150);
    // The upload keeps the whole name: nothing is cut again.
    expect(sanitizeFileName(`${name}.md`)).toBe(`${name}.md`);
    expect(name.startsWith('Acme Productions production pack')).toBe(true);
    // An extension too long to be one is cut with the rest of the name.
    const odd = textDocumentName(`Sam Price.${'x'.repeat(200)}`);
    expect(odd.endsWith('… · text')).toBe(true);
    expect([...odd].length).toBeLessThanOrEqual(150);
  });
});

describe('in SupaMac', () => {
  let dss: FakeDss;
  let client: SupaMacClient;
  let schema: JobsSchema;

  beforeAll(async () => {
    dss = new FakeDss();
    client = new SupaMacClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: dss.fetch,
    });
    schema = (
      await ensureJobsSchema({
        client,
        pins: undefined,
        ownerEmail: OWNER_EMAIL,
        save: async () => {},
      })
    ).schema;
  });

  test('an upload sends the bytes into the folder and returns the document', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 call sheet');
    const uploaded = await uploadFile(client, {
      fileName: 'tmp/Call sheet.pdf',
      bytes,
      folderId: schema.folders.sources,
    });
    expect(uploaded).toEqual({
      documentId: expect.any(String),
      sizeBytes: bytes.byteLength,
      fileName: 'Call sheet.pdf',
    });
    const seen = dss.seen.at(-1);
    expect(seen?.path).toBe('/documents/upload');
    expect(seen?.query).toEqual({
      fileName: 'Call sheet.pdf',
      projectId: schema.folders.sources,
    });
    expect(
      dss.documents.find((d) => d.id === uploaded.documentId)?.projectId
    ).toBe(schema.folders.sources);
  });

  test('an upload over 25 MiB, or empty, is refused before sending', async () => {
    const before = dss.seen.length;
    await rejects(
      uploadFile(client, {
        fileName: 'big.pdf',
        bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
        folderId: schema.folders.sources,
      }),
      'too_large'
    );
    await rejects(
      uploadFile(client, {
        fileName: 'empty.pdf',
        bytes: new Uint8Array(),
        folderId: schema.folders.sources,
      }),
      'empty'
    );
    await rejects(
      uploadFile(client, {
        fileName: 'pack.docx',
        bytes: new Uint8Array([1]),
        folderId: schema.folders.sources,
      }),
      'type_refused'
    );
    expect(dss.seen.length).toBe(before);
  });

  test('a Markdown text becomes a .md upload, with NUL removed', async () => {
    const uploaded = await uploadMarkdown(client, {
      name: textDocumentName('Call sheet.pdf'),
      markdown: '# Call sheet\n\n[S1 p2] Crew call 07:00\u0000',
      folderId: schema.folders.sources,
    });
    expect(uploaded.fileName).toBe('Call sheet.pdf · text.md');
    const doc = dss.documents.find((d) => d.id === uploaded.documentId);
    expect(doc?.fileType).toBe('md');
    expect(new TextDecoder().decode(doc?.bytes)).toBe(
      '# Call sheet\n\n[S1 p2] Crew call 07:00'
    );
  });

  test("the intake folder's documents, with owners and readiness", async () => {
    const owners = dss.addDocument(
      'Example Hotel confirmation',
      'pdf',
      schema.folders.intake,
      OWNER_USER
    );
    const pending = dss.addDocument(
      'PO 4500123',
      'pdf',
      schema.folders.intake,
      SERVICE_USER
    );
    pending.state = 'pending';
    const trashed = dss.addDocument(
      'Old call sheet',
      'pdf',
      schema.folders.intake,
      OWNER_USER
    );
    trashed.deletedAt = dss.now();
    const listed = await listFolderDocuments(client, schema.folders.intake);
    expect(listed.map((d) => [d.name, d.owner, d.readiness])).toEqual([
      ['Example Hotel confirmation', OWNER_USER, undefined],
      ['PO 4500123', SERVICE_USER, undefined],
    ]);
    const ready = await listFolderDocuments(client, schema.folders.intake, {
      readiness: true,
    });
    expect(ready.map((d) => [d.id, d.fileType, d.readiness])).toEqual([
      [owners.id, 'pdf', 'ready'],
      [pending.id, 'pdf', 'pending'],
    ]);
    expect(await documentInfo(client, owners.id)).toEqual({
      id: owners.id,
      name: 'Example Hotel confirmation',
      owner: OWNER_USER,
      fileType: 'pdf',
      folderId: schema.folders.intake,
      trashed: false,
      readiness: 'ready',
    });
  });

  test('a folder holding other kinds of item still lists its documents', async () => {
    const folder = dss.addProject('Mixed');
    const doc = dss.addDocument('Call sheet', 'pdf', folder.id, OWNER_USER);
    dss.overrides.set(`GET /projects/${folder.id}/content`, () =>
      Response.json({
        error: false,
        data: [
          {
            item: {
              type: 'project',
              id: dss.id(),
              name: 'Sub',
              userId: OWNER_USER,
            },
            userAccessLevel: 'edit',
          },
          {
            item: { type: 'database', id: dss.id(), name: 'Jobs copy' },
            userAccessLevel: 'edit',
          },
          {
            item: {
              type: 'document',
              id: doc.id,
              documentVersionId: 1,
              owner: OWNER_USER,
              name: 'Call sheet',
              fileType: 'pdf',
            },
            userAccessLevel: 'edit',
          },
        ],
      })
    );
    expect(
      (await listFolderDocuments(client, folder.id)).map((d) => d.id)
    ).toEqual([doc.id]);
    dss.overrides.set(`GET /projects/${folder.id}/content`, () =>
      Response.json({
        error: false,
        data: [
          { item: { type: 'document', id: doc.id }, userAccessLevel: 'edit' },
        ],
      })
    );
    try {
      await listFolderDocuments(client, folder.id);
      throw new Error('expected a bad_response error');
    } catch (error) {
      expect((error as SupaMacError).kind).toBe('bad_response');
    }
  });

  test('a document moves to Job sources', async () => {
    const doc = dss.addDocument(
      'Travel confirmation',
      'pdf',
      schema.folders.intake,
      OWNER_USER
    );
    await moveDocument(client, doc.id, schema.folders.sources);
    expect(doc.projectId).toBe(schema.folders.sources);
    expect(dss.seen.at(-1)?.body).toEqual({
      projectId: schema.folders.sources,
    });
  });

  test('a download reads the stored bytes through the gateway, without the key', async () => {
    const doc = dss.addDocument(
      'Rota',
      'xlsx',
      schema.folders.intake,
      OWNER_USER,
      new Uint8Array([80, 75, 3, 4])
    );
    expect([...(await downloadDocument(client, doc.id))]).toEqual([
      80, 75, 3, 4,
    ]);
    const object = dss.seen.at(-1);
    expect(object?.path).toBe(`/local-storage/doc-storage/${doc.id}.xlsx`);
    expect(object?.headers['x-macro-user-api-key']).toBeUndefined();
    try {
      await downloadDocument(client, doc.id, { maxBytes: 2 });
      throw new Error('expected a too_large error');
    } catch (error) {
      expect(error).toBeInstanceOf(SupaMacError);
      expect((error as SupaMacError).kind).toBe('too_large');
    }
  });
});

describe('web links', () => {
  test('use the path the app is served from, or /app for an origin alone', () => {
    expect(webAppBase('https://app.example.com')).toEqual({
      origin: 'https://app.example.com',
      basePath: '/app',
    });
    expect(webAppBase('https://example.com/supamac/')).toEqual({
      origin: 'https://example.com',
      basePath: '/supamac',
    });
    documentError(() => webAppBase('not a url'), 'bad_link');
    documentError(() => webAppBase('javascript:alert(1)'), 'bad_link');
  });

  test('a database opens on its table and view', () => {
    const base = webAppBase('https://example.com/supamac');
    expect(databaseLink(base, DB)).toBe(
      `https://example.com/supamac/database/${DB}`
    );
    expect(databaseLink(base, DB, { tableId: TABLE })).toBe(
      `https://example.com/supamac/database/${DB}?tableId=${TABLE}`
    );
    expect(databaseLink(base, DB, { tableId: TABLE, viewId: VIEW })).toBe(
      `https://example.com/supamac/database/${DB}?tableId=${TABLE}&viewId=${VIEW}`
    );
    documentError(() => databaseLink(base, DB, { viewId: VIEW }), 'bad_link');
    expect(() => databaseLink(base, 'Jobs')).toThrow(SupaMacError);
  });

  test('a PDF opens at its 1-based page at the top', () => {
    const base = webAppBase('https://app.example.com');
    expect(pdfPageLink(base, DOC, 3)).toBe(
      `https://app.example.com/app/pdf/${DOC}?pdf_page_number=3&pdf_page_y=0`
    );
    expect(pdfPageLink(base, DOC)).toBe(
      `https://app.example.com/app/pdf/${DOC}`
    );
    documentError(() => pdfPageLink(base, DOC, 0), 'bad_link');
    documentError(() => pdfPageLink(base, DOC, 1.5), 'bad_link');
  });

  test('a Markdown document', () => {
    expect(markdownLink(webAppBase('https://app.example.com'), DOC)).toBe(
      `https://app.example.com/app/md/${DOC}`
    );
  });
});
