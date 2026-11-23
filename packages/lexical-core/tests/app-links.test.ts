// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless';
import {
  $convertFromMarkdownString,
  type ElementTransformer,
} from '@lexical/markdown';
import {
  $getRoot,
  type LexicalNode,
  type SerializedEditorState,
} from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplacements, SupportedNodeTypes } from '../node-list';
import {
  isMacroBookingUrl,
  parseBookingUrl,
} from '../nodes/BookingLinkMentionNode';
import { $createDocumentMentionNode } from '../nodes/DocumentMentionNode';
import { $createPullRequestMentionNode } from '../nodes/PullRequestMentionNode';
import { $createSnapshotNode } from '../nodes/SnapshotNode';
import { $isVideoNode } from '../nodes/VideoNode';
import { INTERNAL_TRANSFORMERS } from '../transformers';
import { E_DOCUMENT_MENTION, E_PR_MENTION } from '../transformers/mentions';
import { E_SNAPSHOT_NODE } from '../transformers/snapshot';
import { isVideoMarkdownLink } from '../transformers/video';
import { configureAppLinks, isStaticFileUrl } from '../utils/app-links';
import {
  markdownToSerializedEditorStateWithIds,
  serializedEditorStateToMarkdown,
} from '../utils/markdown-state';

const APP_URL = 'https://team.example.com/workspace';
const STATIC_FILE_URL = 'https://api.example.com/static-file';

function editor() {
  return createHeadlessEditor({
    nodes: [...SupportedNodeTypes, ...NodeReplacements],
    onError(error) {
      throw error;
    },
  });
}

/** What `transformer` writes for the node `$create` makes. */
function exported(
  transformer: ElementTransformer,
  $create: () => LexicalNode
): string | null {
  let markdown: string | null = null;
  editor().update(
    () => {
      markdown = transformer.export($create(), () => '');
    },
    { discrete: true }
  );
  return markdown;
}

const $documentMention = () =>
  $createDocumentMentionNode({
    documentId: 'doc-1',
    documentName: 'Plan',
    blockName: 'md',
  });

function hasVideo(markdown: string): boolean {
  const instance = editor();
  instance.update(
    () => $convertFromMarkdownString(markdown, INTERNAL_TRANSFORMERS),
    { discrete: true }
  );
  return instance
    .getEditorState()
    .read(() => $getRoot().getChildren().some($isVideoNode));
}

function bookingMention(data: Record<string, string>): string {
  return `<m-booking-link-mention>${JSON.stringify(data)}</m-booking-link-mention>`;
}

function bookingUrlIn(state: SerializedEditorState): unknown {
  return JSON.parse(JSON.stringify(state)).root.children[0].children[0].url;
}

afterEach(() => configureAppLinks({}));

describe('configured app links', () => {
  it('accepts booking links only under the configured app URL', () => {
    configureAppLinks({ appUrl: `${APP_URL}/` });

    expect(isMacroBookingUrl(`${APP_URL}/book/profile-1/intro`)).toBe(true);
    expect(parseBookingUrl(`${APP_URL}/book/profile%201/intro?x=1`)).toEqual({
      profileId: 'profile 1',
      slug: 'intro',
    });
    for (const url of [
      'https://macro.com/app/book/profile-1',
      'https://team.example.com/app/book/profile-1',
      'https://team.example.com.example.net/workspace/book/profile-1',
      'http://team.example.com/workspace/book/profile-1',
    ]) {
      expect(isMacroBookingUrl(url)).toBe(false);
    }
  });

  it('keeps a booking link to the app and rebuilds any other from its profile', () => {
    configureAppLinks({ appUrl: APP_URL });
    const own = `${APP_URL}/book/profile-1/intro`;

    expect(
      bookingUrlIn(
        markdownToSerializedEditorStateWithIds(
          bookingMention({ profileId: 'profile-1', slug: 'intro', url: own })
        )
      )
    ).toBe(own);
    expect(
      bookingUrlIn(
        markdownToSerializedEditorStateWithIds(
          bookingMention({
            profileId: 'profile-1',
            slug: 'intro',
            url: 'https://macro.com/app/book/profile-1',
          })
        )
      )
    ).toBe(own);
  });

  it('rebuilds a saved booking URL that is not the app’s when the state loads', () => {
    configureAppLinks({ appUrl: APP_URL });
    const state = {
      root: {
        type: 'root',
        version: 1,
        direction: null,
        format: '',
        indent: 0,
        children: [
          {
            type: 'paragraph',
            version: 1,
            direction: null,
            format: '',
            indent: 0,
            textFormat: 0,
            textStyle: '',
            children: [
              {
                type: 'booking-link-mention',
                version: 1,
                profileId: 'profile-1',
                slug: 'intro',
                url: 'https://macro.com/app/book/profile-1',
              },
            ],
          },
        ],
      },
    } as unknown as SerializedEditorState;

    const markdown = serializedEditorStateToMarkdown(state);
    expect(markdown).toContain(`"url":"${APP_URL}/book/profile-1/intro"`);
    expect(markdown).not.toContain('macro.com');
  });

  it('links mentions under the configured app URL', () => {
    configureAppLinks({ appUrl: APP_URL });

    expect(exported(E_DOCUMENT_MENTION, $documentMention)).toBe(
      `[Plan](${APP_URL}/md/doc-1)`
    );
    expect(
      exported(E_PR_MENTION, () =>
        $createPullRequestMentionNode({ id: 'pr-1', label: 'Fix' })
      )
    ).toBe(`[Fix](${APP_URL}/pr/pr-1)`);
    expect(
      exported(E_SNAPSHOT_NODE, () =>
        $createSnapshotNode({
          documentId: 'doc-1',
          documentName: 'Plan',
          blockName: 'md',
          content: '',
          snapshotDate: '2026-01-01T00:00:00.000Z',
        })
      )
    ).toBe(`[Plan](${APP_URL}/md/doc-1)`);
  });

  it('embeds a video only from the configured static-file service', () => {
    configureAppLinks({ staticFileUrl: STATIC_FILE_URL });
    const ownFile = `${STATIC_FILE_URL}/file/3d7ab8c8`;

    expect(isVideoMarkdownLink(ownFile, 'Recording.mov')).toBe(true);
    expect(hasVideo(`[Recording.mov](${ownFile})`)).toBe(true);
    expect(hasVideo(`[Report.pdf](${ownFile})`)).toBe(false);
    expect(
      isVideoMarkdownLink(
        'https://static-file-service.macro.com/file/3d7ab8c8',
        'Recording.mov'
      )
    ).toBe(false);
    expect(
      hasVideo(
        '[Recording.mov](https://static-file-service.macro.com/file/3d7ab8c8)'
      )
    ).toBe(false);
  });

  it('refuses a value that is not an absolute URL', () => {
    expect(() => configureAppLinks({ appUrl: '/workspace' })).toThrow();
  });
});

describe('app links without configuration', () => {
  it('link under `/app` on the page’s own origin', () => {
    const origin = window.location.origin;
    expect(exported(E_DOCUMENT_MENTION, $documentMention)).toBe(
      `[Plan](${origin}/app/md/doc-1)`
    );
    expect(isMacroBookingUrl(`${origin}/app/book/profile-1`)).toBe(true);
    expect(
      isMacroBookingUrl('https://team.example.com/workspace/book/profile-1')
    ).toBe(false);
  });

  it('trust no other host', () => {
    expect(isMacroBookingUrl('https://macro.com/app/book/profile-1')).toBe(
      false
    );
    expect(
      isStaticFileUrl('https://static-file-service.macro.com/file/file-1')
    ).toBe(false);
  });
});
