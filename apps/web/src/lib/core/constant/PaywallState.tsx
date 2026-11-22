import { docsUrl } from '@app/constants/docs-links';
import { PRODUCT_NAME } from '@app/constants/product';
import { createSignal } from 'solid-js';
import { SELF_HOSTED } from './servers';

const DAILY_LIMIT = 5;

export enum PaywallKey {
  PROJECT_LIMIT = 'PROJECT_LIMIT',
  FILE_LIMIT = 'FILE_LIMIT',
  IMAGE_LIMIT = 'IMAGE_LIMIT',
  CHAT_LIMIT = 'CHAT_LIMIT',
  O1_LIMIT = 'O1_LIMIT',
  CANVAS_CLIKED = 'CANVAS_CLIKED',
  SAVED_PROMPT = 'SAVED_PROMPT',
  REMOVE_SIGNATURE = 'REMOVE_SIGNATURE',
  MULTI_INBOX = 'MULTI_INBOX',
  TEAMS = 'TEAMS',
}

export type PaywallMessageMetadata = {
  title: string;
  description: string;
  learnMoreUrl?: string;
  learnMoreSubject?: string;
};

export const PaywallMessages: Record<PaywallKey, PaywallMessageMetadata> = {
  [PaywallKey.PROJECT_LIMIT]: {
    title: 'Folder limit reached',
    description:
      'Upgrade to create more folders and keep organizing your workspace.',
    learnMoreUrl: docsUrl('/product/drive'),
    learnMoreSubject: 'folders',
  },
  [PaywallKey.FILE_LIMIT]: {
    title: 'File limit reached',
    description: 'Upgrade for more storage and room for all of your documents.',
  },
  [PaywallKey.CHAT_LIMIT]: {
    title: 'Chat limit reached',
    description:
      'Upgrade to keep creating agent chats with access to every AI model.',
    learnMoreUrl: docsUrl('/product/agents'),
    learnMoreSubject: 'agents',
  },
  [PaywallKey.IMAGE_LIMIT]: {
    title: 'Image processing limit reached',
    description: `You’ve used ${DAILY_LIMIT} AI image processing requests today. Upgrade for higher limits.`,
    learnMoreUrl: docsUrl('/product/agents'),
    learnMoreSubject: 'agents',
  },
  [PaywallKey.O1_LIMIT]: {
    title: 'Smart models require Pro or Max',
    description: `Upgrade to use ${PRODUCT_NAME}’s most capable AI models.`,
    learnMoreUrl: docsUrl('/product/agents'),
    learnMoreSubject: 'agents',
  },
  [PaywallKey.CANVAS_CLIKED]: {
    title: 'AI canvases require Pro or Max',
    description:
      'Upgrade to generate diagrams, whiteboards, and visual drafts with AI.',
    learnMoreUrl: docsUrl('/product/canvas'),
    learnMoreSubject: 'canvases',
  },
  [PaywallKey.SAVED_PROMPT]: {
    title: 'Saved prompts require Pro or Max',
    description: 'Upgrade to save reusable prompts for faster workflows.',
    learnMoreUrl: docsUrl('/product/snippets'),
    learnMoreSubject: 'saved prompts',
  },
  [PaywallKey.REMOVE_SIGNATURE]: {
    title: `Remove the ${PRODUCT_NAME} signature`,
    description: `Upgrade to send emails without the ${PRODUCT_NAME} signature.`,
    learnMoreUrl: docsUrl('/product/email'),
    learnMoreSubject: 'email',
  },
  [PaywallKey.MULTI_INBOX]: {
    title: 'Connect more inboxes',
    description: 'Upgrade your plan to connect more than two inboxes.',
    learnMoreUrl: docsUrl('/product/home'),
    learnMoreSubject: 'multiple inboxes',
  },
  [PaywallKey.TEAMS]: {
    title: 'Collaborate with your team',
    description:
      'Upgrade to create a team, invite members, and manage access together.',
    learnMoreUrl: docsUrl('/account/teams'),
    learnMoreSubject: 'teams',
  },
};

// A self-hosted instance sells no plan, so its notice names the limit where
// the plans' title names a plan or invites a purchase.
const SELF_HOSTED_LIMIT_TITLES: Partial<Record<PaywallKey, string>> = {
  [PaywallKey.O1_LIMIT]: 'This model is not available on this instance',
  [PaywallKey.MULTI_INBOX]: 'Inbox limit reached',
};

/** The title of the notice a self-hosted instance shows for a limit. */
export function limitNoticeTitle(key: PaywallKey): string {
  return SELF_HOSTED_LIMIT_TITLES[key] ?? PaywallMessages[key].title;
}

const [paywallOpen, setPaywallOpen] = createSignal(false);
// export const [paywallOpen, setPaywallOpen] = createControlledOpenSignal(false);
const [limitReached, _setLimitReached] = createSignal(false);
const [paywallKey, setPaywallKey] = createSignal<PaywallKey | null>(null);

export const usePaywallState = () => {
  const showPaywall = (errorKey?: PaywallKey | null) => {
    // A self-hosted instance has no plans to offer, so it opens only to name
    // the limit its server refused on.
    if (SELF_HOSTED && !errorKey) return;

    if (errorKey) {
      setPaywallKey(errorKey);
    }
    setPaywallOpen(true);
  };

  const hidePaywall = () => {
    setPaywallOpen(false);
    setPaywallKey(null);
  };
  return { paywallOpen, showPaywall, hidePaywall, limitReached, paywallKey };
};
