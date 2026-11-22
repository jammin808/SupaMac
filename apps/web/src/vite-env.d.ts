interface ImportMetaEnv {
  readonly VITE_ENABLE_CRM_SELECTIVE_EMAIL_CONTRIBUTION?: string;
  readonly __APP_VERSION__: string;
  /** When this build was made, in ms since the epoch. Unset outside app builds. */
  readonly __APP_BUILD_TIME__?: number;
  /** The path the web bundle is served from. Unset outside app builds, which run at `/app`. */
  readonly __APP_BASE_PATH__?: string;
  /**
   * The origin of a self-hosted backend's single-origin proxy. Set, the bundle
   * addresses every service under it and loads no upstream analytics.
   */
  readonly VITE_BACKEND_ORIGIN?: string;
  readonly __LOCAL_JWT__: string;
  readonly __GIT_BRANCH__: string;

  readonly VITE_SEGMENT_WRITE_KEY: string;
  readonly VITE_POSTHOG_API_KEY: string;

  /** `true` in bundles `just stack` builds, which count as local (`LOCAL_ONLY`). */
  readonly VITE_LOCAL_ONLY?: string;
  /**
   * `true` when `run_local` / `just stack` serves the app: the backend is a
   * self-contained local stack whose proxy keeps each instance's cookies apart.
   * Unset for `run_dev`, whose proxy shares cookies with the dev gateway.
   */
  readonly VITE_LOCAL_STACK?: string;
  readonly VITE_OTEL_EXPORTER_URL?: string;
  readonly VITE_OTEL_ENV?: string;
  readonly VITE_ENABLE_BROWSER_OTEL?: string;
  /** `true` logs each `perfMark` as a `[perf]` console line. */
  readonly VITE_PERF_LOG?: string;
  readonly VITE_ENABLE_REMINDERS?: string;
  readonly VITE_ENABLE_ENTITY_APPEARANCE?: string;
  readonly VITE_ENABLE_ROUTINE_SHARING?: string;
  readonly VITE_ENABLE_EVENT_ROUTINES?: string;
  readonly VITE_ENABLE_ROUTINE_STARTER_TEMPLATES?: string;
  readonly VITE_ENABLE_ROUTINE_CODE_STEPS?: string;
  readonly VITE_ENABLE_ROUTINE_BACKGROUND_DRAFTS?: string;
  readonly VITE_ENABLE_ROUTINE_SUGGESTIONS?: string;
  readonly VITE_ENABLE_SUGGESTIONS?: string;
  readonly VITE_ENABLE_CHAT_SIDEBAR_SECTIONS?: string;
  readonly VITE_ENABLE_CHAT_SIDEBAR_SECTION_RESIZE?: string;
  readonly VITE_DISABLE_BROWSER_TURSO_CACHE?: string;
  readonly VITE_DISABLE_CRM_CONTACT_SEARCH?: string;
  readonly VITE_ENABLE_WHATSAPP_LINKED?: string;
  /**
   * Sign-in methods of a self-hosted bundle besides the emailed code; each is
   * off there unless set to `true`. Other builds do not read them.
   */
  readonly VITE_ENABLE_GOOGLE_SIGN_IN?: string;
  readonly VITE_ENABLE_APPLE_SIGN_IN?: string;
  readonly VITE_ENABLE_PASSWORD_SIGN_IN?: string;
  readonly VITE_ENABLE_DOMAIN_SSO_SIGN_IN?: string;
  /** Continue with Microsoft, in every build. */
  readonly VITE_ENABLE_MICROSOFT_SIGNUP?: string;
  /** `false` removes calls, for a backend with no media server. */
  readonly VITE_ENABLE_CALLS?: string;
  /**
   * `false` removes the tutorial video entries, for a bundle published under
   * another name or without the videos.
   */
  readonly VITE_ENABLE_VIDEO_TUTORIALS?: string;
  readonly VITE_ENABLE_SOUP_GROUP_BY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
