// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from '@lexical/markdown';
import { $getRoot, type LexicalNode } from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplacements, SupportedNodeTypes } from '../node-list';
import { $createDocumentMentionNode } from '../nodes/DocumentMentionNode';
import { INTERNAL_TRANSFORMERS } from '../transformers';
import {
  E_BOOKING_LINK_MENTION,
  E_DOCUMENT_MENTION,
} from '../transformers/mentions';
import { configureAppLinks } from '../utils/app-links';

// A service converting Markdown has no page: its links come from the app URL
// it configures, and without one it invents no host.

function editor() {
  return createHeadlessEditor({
    nodes: [...SupportedNodeTypes, ...NodeReplacements],
    onError(error) {
      throw error;
    },
  });
}

/** The node's internal Markdown and what the external exporter writes. */
function convert(markdown: string) {
  const instance = editor();
  instance.update(
    () => $convertFromMarkdownString(markdown, INTERNAL_TRANSFORMERS),
    { discrete: true }
  );
  return instance.getEditorState().read(() => {
    const node = $getRoot().getFirstDescendant() as LexicalNode;
    return {
      internal: $convertToMarkdownString(INTERNAL_TRANSFORMERS),
      external: E_BOOKING_LINK_MENTION.export(node, () => ''),
    };
  });
}

function documentMentionLink(): string | null {
  let markdown: string | null = null;
  editor().update(
    () => {
      markdown = E_DOCUMENT_MENTION.export(
        $createDocumentMentionNode({
          documentId: 'doc-1',
          documentName: 'Plan',
          blockName: 'md',
        }),
        () => ''
      );
    },
    { discrete: true }
  );
  return markdown;
}

const BOOKING =
  '<m-booking-link-mention>{"profileId":"profile-1","slug":"intro","label":"Intro","url":"https://team.example.com/app/book/profile-1/intro"}</m-booking-link-mention>';

afterEach(() => configureAppLinks({}));

describe('app links outside a page', () => {
  it('leave a booking link they cannot place empty', () => {
    expect(typeof window).toBe('undefined');
    const { internal, external } = convert(BOOKING);

    expect(internal).toContain('"url":""');
    expect(internal).toContain('"profileId":"profile-1"');
    expect(external).toBe('Intro');
  });

  it('write mentions as their labels', () => {
    expect(documentMentionLink()).toBe('Plan');
  });

  it('build links from the configured app URL', () => {
    configureAppLinks({ appUrl: 'https://team.example.com/workspace' });

    expect(convert(BOOKING).external).toBe(
      '[Intro](https://team.example.com/workspace/book/profile-1/intro)'
    );
    expect(documentMentionLink()).toBe(
      '[Plan](https://team.example.com/workspace/md/doc-1)'
    );
  });
});
