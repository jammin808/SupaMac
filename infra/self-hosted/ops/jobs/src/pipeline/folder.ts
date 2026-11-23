// The Job intake folder (docs/supamac/jobs.md §1): listed every minute; each
// document the owner or the service owns, ready, and not yet in Sources is a
// source; once it finishes it moves to Job sources.
//
// Invariants:
// - A document is taken once: the state's folder index and the Sources
//   Document column are both read before it is downloaded.
// - A document owned by anyone else is never read (the folder is shared with
//   the owner only; anything else in it is left where it is).
// - A document whose bytes are not stored yet is left for a later poll.
// - A finished source's document moves to Job sources; a move that failed
//   is tried again on the next poll. A document that duplicates a source
//   already recorded moves too, so it is not listed again.

import type { PipelineContext } from './context';
import {
  moveFolderDocument,
  processSource,
  type SourceResult,
} from './process';

export interface FolderPollResult {
  readonly seen: number;
  readonly processed: readonly SourceResult[];
  /** Documents left alone, and why. */
  readonly skipped: readonly {
    readonly documentId: string;
    readonly why: string;
  }[];
}

export async function pollFolder(
  ctx: PipelineContext
): Promise<FolderPollResult> {
  const schema = ctx.store.schema;
  const owners = new Set([
    schema.ownerUserId.toLowerCase(),
    schema.serviceUserId.toLowerCase(),
  ]);
  const documents = await ctx.store.folderDocuments('intake');
  const processed: SourceResult[] = [];
  const skipped: { documentId: string; why: string }[] = [];
  for (const doc of documents) {
    const known = ctx.state.value.folderDocs[doc.id];
    if (known !== undefined) {
      // The source's own document moves once it finishes; a copy of it now.
      const meta = ctx.state.value.sources[known];
      if (meta === undefined || meta.folderDocumentId === doc.id)
        await moveFolderDocument(ctx, known);
      else await moveCopy(ctx, doc.id);
      continue;
    }
    if (!owners.has(doc.owner.toLowerCase())) {
      skipped.push({
        documentId: doc.id,
        why: 'owned by someone other than the owner or the service',
      });
      continue;
    }
    if (doc.readiness !== 'ready') {
      skipped.push({ documentId: doc.id, why: 'its bytes are not stored yet' });
      continue;
    }
    const recorded = (await ctx.store.sources({ documentId: doc.id })).rows[0];
    if (recorded !== undefined) {
      await ctx.state.update((s) => {
        s.folderDocs[doc.id] = recorded.id;
      });
      await moveFolderDocument(ctx, recorded.id);
      continue;
    }
    const bytes = await ctx.store.downloadDocument(doc.id);
    const name =
      doc.fileType &&
      !doc.name.toLowerCase().endsWith(`.${doc.fileType.toLowerCase()}`)
        ? `${doc.name}.${doc.fileType}`
        : doc.name;
    const result = await processSource(ctx, {
      via: 'Folder',
      name,
      bytes,
      from: doc.owner,
      folderDocumentId: doc.id,
    });
    if (result.kind === 'duplicate') {
      await ctx.state.update((s) => {
        s.folderDocs[doc.id] = result.sourceId;
      });
      await moveCopy(ctx, doc.id);
    }
    processed.push(result);
  }
  return { seen: documents.length, processed, skipped };
}

/**
 * Moves a document that repeats a recorded source to Job sources; one still
 * listed in Job intake on a later poll is moved then.
 */
async function moveCopy(
  ctx: PipelineContext,
  documentId: string
): Promise<void> {
  try {
    await ctx.store.moveDocument(documentId, 'sources');
  } catch (error) {
    ctx.logger.warn('duplicate intake document not moved yet', {
      documentId,
      error,
    });
  }
}
