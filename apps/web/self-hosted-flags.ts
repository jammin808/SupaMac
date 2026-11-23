/**
 * The feature set of a self-hosted bundle: a build with VITE_BACKEND_ORIGIN
 * set (docs/supamac/static-publishing.md).
 *
 * Such a bundle has no PostHog project. Nothing answers for a remote flag
 * there, so a flag without a value is off, and a screen that waits for the
 * answer waits for good. Every flag that
 * `src/lib/core/constant/featureFlags.ts` defines therefore has a line here:
 * its value in a self-hosted bundle and the reason.
 * `scripts/self-hosted-flags.test.ts` fails when one is missing, so a flag a
 * newer upstream snapshot adds gets a decision before it ships.
 *
 * On: what the stack in `infra/self-hosted` serves (documents, channels and
 * messages, email, calendar, CRM, tasks, the assistant, search). Off: what
 * needs a service, a provider account or an app that stack does not have, and
 * what the server itself gates on a PostHog answer it cannot get.
 */

/** A flag's value in a self-hosted bundle, and why. */
type FlagDecision = readonly [enabled: boolean, reason: string];

/**
 * Keyed by the flag's `env` name. The build hands each to the bundle as
 * `VITE_<name>` (`selfHostedFlagDefines`, used by `vite.base.ts`).
 */
export const SELF_HOSTED_FLAGS: Record<string, FlagDecision> = {
  // Sign-in. The emailed code is the one method that needs no setup.
  ENABLE_GOOGLE_SIGN_IN: [
    false,
    'No Google OAuth client is configured; turn on once the backend has one.',
  ],
  ENABLE_MICROSOFT_SIGNUP: [
    false,
    'No Microsoft identity provider is configured.',
  ],
  ENABLE_APPLE_SIGN_IN: [
    false,
    'For the iOS app; the gateway refuses the route and no provider is configured.',
  ],
  ENABLE_PASSWORD_SIGN_IN: [false, 'The gateway refuses password sign-in.'],
  ENABLE_DOMAIN_SSO_SIGN_IN: [
    false,
    'No organization identity provider is configured.',
  ],

  // Emergency stops. Off leaves the feature they stop running.
  DISABLE_BROWSER_TURSO_CACHE: [false, 'The local cache stays on.'],
  DISABLE_CRM_CONTACT_SEARCH: [false, 'CRM contacts stay searchable.'],

  // Documents and files.
  ENABLE_PDF_MODIFICATION_DATA_AUTOSAVE: [true, 'Production default.'],
  ENABLE_PDF_LOCATION_AUTOSAVE: [true, 'Production default.'],
  ENABLE_PDF_TABS: [true, 'Production default.'],
  ENABLE_PDF_MARKUP: [true, 'Production default.'],
  ENABLE_PDF_MULTISPLIT: [true, 'Production default.'],
  ENABLE_SCRIPTING: [false, 'Production default: PDF scripting is off.'],
  ENABLE_PROJECT_SHARING: [true, 'Production default.'],
  ENABLE_CANVAS_IMAGES: [true, 'Production default.'],
  ENABLE_CANVAS_FILES: [true, 'Production default.'],
  ENABLE_CANVAS_TEXT: [true, 'Production default.'],
  ENABLE_LIVE_INDICATORS: [true, 'Production default.'],
  ENABLE_PROFILE_PICTURES: [true, 'Production default.'],
  ENABLE_VIDEO_BLOCK: [true, 'Production default.'],
  ENABLE_DOCX_TO_PDF: [
    true,
    'Production default; the converter it relies on is not in the stack.',
  ],
  ENABLE_DOCX_EDITOR: [
    false,
    'Opens a Word file from its unpacked parts; the stack does not run the unpacking.',
  ],
  ENABLE_MARKDOWN_LIVE_COLLABORATION: [true, 'Production default.'],
  ENABLE_BLOCK_IN_BLOCK: [true, 'Production default.'],
  ENABLE_MARKDOWN_DIFF: [true, 'Production default.'],
  ENABLE_MARKDOWN_SEARCH_TEXT: [
    false,
    'Production default: on in development only.',
  ],
  ENABLE_MARKDOWN_COMMENTS: [true, 'Production default.'],
  ENABLE_REFERENCES_MODAL: [true, 'Production default.'],
  ENABLE_MENTION_TRACKING: [true, 'Production default.'],
  ENABLE_SVG_PREVIEW: [true, 'Production default.'],
  ENABLE_DOCUMENT_MENTION_NOTIFICATIONS: [
    false,
    'Production default: on in development only.',
  ],
  ENABLE_STATIC_DOCUMENT_CARDS: [false, 'Production default.'],
  ENABLE_MARKDOWN_AI_GENERATE: [false, 'Production default.'],
  ENABLE_MARKDOWN_SIDE_PANEL: [true, 'Production default.'],
  ENABLE_REFOCUS_HIGHLIGHT: [true, 'Production default.'],
  ENABLE_CREATE_PROPERTY: [true, 'Production default.'],
  ENABLE_ENTITY_APPEARANCE: [
    true,
    'Icons and colors for documents, projects and databases, kept by the storage service.',
  ],
  ENABLE_HISTORY_COMPONENT: [true, 'Version history of a document.'],
  ENABLE_PPTX_EDITOR: [
    true,
    'Edits presentations in the browser, over the sync service.',
  ],
  ENABLE_PSD_EDITOR: [
    true,
    'Edits layered images in the browser, over the sync service.',
  ],
  ENABLE_FIG_VIEWER: [
    true,
    'Shows design files in the browser, over the sync service.',
  ],
  ENABLE_AI_EDITOR: [
    true,
    'Edits vector artwork in the browser, over the sync service.',
  ],
  SHOW_DATABASE_SQL: [false, 'Production default: a debugging aid.'],
  ENABLE_CAROUSEL_CREATE_MENU: [
    false,
    'An opt-in variant of the create menu; the detailed launcher is the default.',
  ],

  // Channels and messages.
  ENABLE_CHAT_CHANNEL_ATTACHMENT: [true, 'Production default.'],
  UNIFIED_CHANNEL_INPUT: [false, 'Production default.'],
  ENABLE_CHAT_SIDEBAR_SECTIONS: [
    true,
    'The Chat sidebar with sections, kept by the storage service.',
  ],
  ENABLE_CHAT_SIDEBAR_SECTION_RESIZE: [
    false,
    'Off in development too: sections keep their natural height.',
  ],
  ENABLE_CHANNEL_TAGS: [
    false,
    'Off in development too: channel labels are not released.',
  ],
  ENABLE_CHANNEL_THREADS_PREVIEW: [true, 'The Threads tab of the Chat view.'],
  ENABLE_CHANNEL_NOTIFICATION_SETTINGS: [
    true,
    'Per-channel and per-section notification settings; the notification service serves them unflagged.',
  ],
  ENABLE_CHANNEL_NOTIFICATION_GUTTER: [
    false,
    'The gutter of Mark done checks is in its first rollout upstream; production default.',
  ],
  ENABLE_CALLS: [
    false,
    'Calls need a media server, which the stack does not run.',
  ],
  ENABLE_CALLKIT: [
    false,
    'The call screen of the iOS app; calls are off and there is no app.',
  ],
  ENABLE_AGENT_DMS: [false, 'Production default: on in development only.'],

  // Email, with the stack's `email` profile.
  ENABLE_EMAIL: [true, 'Production default.'],
  ENABLE_INBOX_RESYNC: [false, 'Production default.'],
  ENABLE_INBOX_SYNC_STATUS: [true, 'Production default.'],
  ENABLE_EMAIL_SHARING: [true, 'Production default.'],
  ENABLE_EMAIL_SCHEDULED_SEND: [true, 'Production default.'],
  ENABLE_PROXY_EMAIL_IMAGES: [true, 'Production default.'],
  ENABLE_CLIENT_EMAIL_SIGNAL_FILTER: [false, 'Production default.'],
  ENABLE_REMINDERS: [
    true,
    'Email reminders; the stack ticks the reminder queue each minute.',
  ],
  ENABLE_EMAIL_WIDE_SEARCH: [
    true,
    'The search field of Mail and its recent searches.',
  ],
  ENABLE_EMAIL_FOCUS: [
    false,
    'The Focus tab is filled by a classifier worker the stack does not run.',
  ],

  // Calendar, with the stack's `email` profile.
  ENABLE_GRAPHQL_CALENDAR: [
    false,
    'Calendars read from the calendar service, the path every browser can use.',
  ],
  ENABLE_CALENDAR_SEARCH_UI: [false, 'Calendar search is off in the stack.'],
  ENABLE_CALENDAR_TEAM_OOO: [
    false,
    'Shows teammates who are away; kept off with team calendar sharing.',
  ],
  ENABLE_CALENDAR_TEAM_SHARING: [
    false,
    'The server rolls team calendars out by its own switch, which the stack does not set.',
  ],
  ENABLE_CALENDAR_GUEST_INVITES: [
    true,
    'A guest adding guests; the invite routes apply the organizer’s policy themselves.',
  ],
  ENABLE_CALENDAR_INVITATION_FORWARD: [
    false,
    'Kept to development upstream until a real send has been checked.',
  ],
  ENABLE_CALENDAR_ADD_SHARED_EVENT: [
    false,
    'Kept to development upstream until a real import has been checked.',
  ],

  // CRM.
  ENABLE_CONTACT_LISTS: [
    false,
    'Reads list membership the server reads from PostHog (contacts-list-reads), which answers off here.',
  ],
  ENABLE_CRM_LISTS: [
    true,
    'Lists of companies, kept by the storage service with the saved views.',
  ],
  ENABLE_CRM_SELECTIVE_EMAIL_CONTRIBUTION: [
    false,
    'The server requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_SOUP_GROUP_BY: [true, 'The Group control of task, tag and CRM lists.'],

  // Tasks and projects.
  ENABLE_TASK_SOURCE_PROPERTY: [
    true,
    'Fills a task’s Source from the place it was created in.',
  ],
  ENABLE_TASK_TEMPLATES: [
    true,
    'Task templates in the composer; the storage service serves them.',
  ],
  ENABLE_GANTT: [
    false,
    'The timeline layout; upstream shows it in local previews only.',
  ],
  ENABLE_TASKS_REVIEWS: [
    false,
    'Reviews lists GitHub pull requests; no GitHub app is connected.',
  ],

  // Lists, Home, notifications and search.
  ENABLE_UNIFIED_LIST_AI_INPUT: [true, 'Production default.'],
  ENABLE_FEATURED_SEARCH_RESULTS: [true, 'Production default.'],
  ENABLE_SEARCH_SERVICE: [
    true,
    'Production default; answers come with the stack’s `search` profile.',
  ],
  ENABLE_GRAPHQL_BACKFILL: [true, 'Production default.'],
  ENABLE_SOUP_FILTER_PERSISTENCE: [
    false,
    'Off in development too: its rollout is not finished.',
  ],
  ENABLE_INBOX_NOTIFIED_SORT: [true, 'Sorts Home by the latest notification.'],
  ENABLE_ENTITY_ACTIVITY_SECTION: [
    true,
    'The Activity section of an item’s side panel, from the activity log.',
  ],
  ENABLE_ACTIVITY_FEED: [true, 'The Activity view, from the activity log.'],
  ENABLE_UNIFIED_NOTIFICATIONS: [true, 'The Notifications view and its bell.'],
  ENABLE_AGENT_NOTIFICATIONS: [
    true,
    'The Agent pings setting. The notification service lets agents send pings whenever ENVIRONMENT=local, as this stack runs, so people need the setting to turn them off.',
  ],
  ENABLE_NEW_HOME: [
    false,
    'The Home with Recent and Notifications tabs is in rollout upstream; production default.',
  ],
  DISABLE_OLD_HOME: [false, 'Only meaningful with ENABLE_NEW_HOME on.'],
  ENABLE_NAVIGATION_UNREAD_COUNTS: [
    false,
    'Production default: off in every build.',
  ],
  ENABLE_RECENT_VIEW: [true, 'The Recent view of what the viewer touched.'],
  ENABLE_TAG_TEAM_SHARING: [
    true,
    'Sharing a personal tag with the team; its routes carry no flag.',
  ],
  ENABLE_UNIVERSAL_INPUT: [
    true,
    'Long input in the command menu, read by the agent harness.',
  ],

  // The assistant and agents.
  ENABLE_TTFT: [false, 'Production default: a timing readout for development.'],
  ENABLE_AGENT_SESSION_ACTIVITY: [
    true,
    'What the agent did in a session, from the activity log.',
  ],
  ENABLE_ROUTINE_STARTER_TEMPLATES: [true, 'The built-in routine templates.'],
  ENABLE_ROUTINE_BACKGROUND_DRAFTS: [
    false,
    'The dialog waits for the draft, which works without the background routes.',
  ],
  ENABLE_FIRST_PROMPT_ON_CREATE: [
    false,
    'Deployed default: creating a session and then prompting works with any harness.',
  ],
  ENABLE_AGENT_WORK: [
    false,
    'Work that agent teammates register, shown in their DMs and in calls; both are off.',
  ],
  ENABLE_AGENT_UPDATES: [
    false,
    'Updates and pull requests of coding agents, which need a sandbox provider.',
  ],
  ENABLE_AGENT_TEAMMATES: [
    false,
    'Agent teammates run on computers rented from the hosted service.',
  ],
  ENABLE_COMPOSER_AUTO_MODE: [
    false,
    'The harness requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_CURSOR_AGENTS: [
    false,
    'Hands work to a third-party coding agent, which needs a sandbox provider.',
  ],
  ENABLE_CODEX_AGENTS: [
    false,
    'Off in development too; a third-party coding agent.',
  ],
  ENABLE_ROUTINE_SUGGESTIONS: [
    false,
    'The scheduler requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_ROUTINE_SHARING: [
    false,
    'The server requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_EVENT_ROUTINES: [
    false,
    'The server requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_SUGGESTIONS: [
    false,
    'The server requires the same flag, which it reads from PostHog.',
  ],
  ENABLE_PR_DISCUSSION_INPUT: [false, 'Production default.'],
  USE_MACRO_PR_SUMMARY_BLOCK: [
    true,
    'Production default; only a GitHub pull request reaches it.',
  ],

  // Services, apps and accounts only the hosted service has.
  ENABLE_MACRO_CONNECT: [
    false,
    'Connectors served by the hosted service’s broker.',
  ],
  ENABLE_WHATSAPP_LINKED: [
    false,
    'Needs the WhatsApp session service, which the stack does not run.',
  ],
  ENABLE_PASSWORDS: [
    false,
    'The vault needs a secrets store that is not part of the stack.',
  ],
  ENABLE_IN_APP_TOURS: [
    false,
    'The tours play videos the hosted service publishes.',
  ],
  ENABLE_VIDEO_TUTORIALS: [
    false,
    'The tutorials are recordings of the hosted service under its own name, and packaging can leave the videos out.',
  ],
  ENABLE_DESKTOP_TABS: [false, 'Tabs in the title bar of the desktop app.'],
  ENABLE_APP_STORE_QR_CODE: [
    false,
    'Points to the hosted service’s mobile apps in the app stores.',
  ],
  ENABLE_AUTO_UPDATE_UI: [false, 'The update rows of the native apps.'],

  // Transport.
  SYNC_VIA_GATEWAY: [
    false,
    'Documents sync over the sync service’s own socket, which the gateway routes.',
  ],
  ENABLE_BEARER_TOKEN_AUTH: [false, 'Production default.'],
};

/**
 * Remote flags with no `env` name: no build can turn them on, so in a
 * self-hosted bundle they are off. Keyed by PostHog key. To turn one on, give
 * it an `env` in featureFlags.ts and list it above instead.
 */
export const SELF_HOSTED_FLAGS_WITHOUT_SWITCH: Record<string, string> = {
  'desktop-app': 'The download page of the desktop app; this fork ships none.',
  'enable-crm-thread-exclusions':
    'The server requires the same flag, which it reads from PostHog.',
  'enable-crm-member-access-changes':
    'The server requires the same flag, which it reads from PostHog.',
  'enable-supported-soup-foreign-entities':
    'Adds GitHub pull requests to Home; no GitHub app is connected.',
  'disable-auto-update-ui':
    'A stop for the native apps’ update rows, which ENABLE_AUTO_UPDATE_UI above already hides.',
};

/**
 * Vite `define` entries that give a bundle the flags above, as the `VITE_*`
 * strings the app reads. A variable the build's own environment sets is left
 * out, so it wins; an empty one counts as unset.
 */
export function selfHostedFlagDefines(
  env: Record<string, string | undefined>
): Record<string, string> {
  const defines: Record<string, string> = {};

  for (const [name, [enabled]] of Object.entries(SELF_HOSTED_FLAGS)) {
    const variable = `VITE_${name}`;
    if (env[variable]) continue;
    defines[`import.meta.env.${variable}`] = JSON.stringify(String(enabled));
  }

  return defines;
}
