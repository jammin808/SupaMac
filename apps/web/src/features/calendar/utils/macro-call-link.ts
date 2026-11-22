import { fromWebBasePath } from '@app/constants/routerBase';
import { PRODUCT_NAME } from '@app/lib/constants/product';
import { getWebOrigin } from '@core/util/webOrigin';

interface CalendarCallContent {
  conferenceUrl?: string | null;
  location?: string | null;
  description?: string | null;
}

/**
 * The label of the paragraph written into an event for its meeting link. The
 * calendar service writes the same label (`JOIN_LINE_LABEL` in
 * `crates/calendar_events/src/domain/meeting_links.rs`) and finds the
 * paragraph by it to leave the way into the call out of channel shares and
 * shared event files, so the two stay equal: a paragraph written under a
 * label the service does not recognize is shared with them.
 */
const CALL_LINK_LABEL = `Join ${PRODUCT_NAME} call`;

/**
 * Labels a generated paragraph is recognized by: the one written here and
 * the hosted product's, which events stored earlier and its invitations carry
 * (`OTHER_JOIN_LINE_LABELS` on the service). Recognizing more than is written
 * is safe; writing a label the service does not recognize is not.
 */
const GENERATED_CALL_LINK_LABELS = [CALL_LINK_LABEL, 'Join Macro call'];

function generatedCallLinkUrl(text: string): string | undefined {
  const lowered = text.toLowerCase();
  for (const label of GENERATED_CALL_LINK_LABELS) {
    const prefix = `${label.toLowerCase()}:`;
    if (!lowered.startsWith(prefix)) continue;
    const url = text.slice(prefix.length).trimStart();
    return url && !/\s/.test(url) ? url : undefined;
  }
  return undefined;
}

/**
 * Accept only Macro meeting links: this deployment's own, the hosted
 * product's, and local development links.
 */
export function macroCallUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const local =
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      url.hostname === '127.0.0.1';
    const own = url.origin === getWebOrigin();
    const path = fromWebBasePath(url.pathname) ?? url.pathname;
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      (!local &&
        !own &&
        url.hostname !== 'macro.com' &&
        url.hostname !== 'dev.macro.com') ||
      url.username ||
      url.password ||
      !/^\/meet\/(?:join\/)?[A-Za-z0-9_-]{16,128}\/?$/.test(path)
    ) {
      return undefined;
    }
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch {
    return undefined;
  }
}

/** The shared meeting travels in ordinary calendar fields and external invites. */
export function calendarMacroCallUrl(event: CalendarCallContent) {
  for (const content of [
    event.conferenceUrl,
    event.location,
    event.description,
  ]) {
    for (const candidate of content?.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
      const url = macroCallUrl(candidate.replace(/&amp;/g, '&'));
      if (url) return url;
    }
  }
  return undefined;
}

/** Remove only the paragraph generated for this meeting, preserving user text. */
export function removeCalendarMacroCall(
  content: Pick<CalendarCallContent, 'description' | 'location'>,
  existingUrl: string | undefined
) {
  const description = content.description ?? '';
  const location = content.location ?? '';
  if (!existingUrl) return { description, location };
  return {
    description: description
      .replace(
        /<(p|div)\b[^>]*>(?:(?!<(?:p|div)\b)[\s\S])*?<\/\1>/gi,
        (paragraph) => {
          const text = paragraph
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .trim();
          const linkedUrl = calendarMacroCallUrl({ description: paragraph });
          const textUrl = generatedCallLinkUrl(text);
          const generated =
            GENERATED_CALL_LINK_LABELS.includes(text) ||
            (textUrl !== undefined && macroCallUrl(textUrl) === linkedUrl);
          return generated && linkedUrl ? '' : paragraph;
        }
      )
      .trim(),
    location: macroCallUrl(location.trim()) === existingUrl ? '' : location,
  };
}

/** The location event details show: empty when it is only the meeting's Macro call link. */
export function calendarEventLocation(event: CalendarCallContent) {
  return removeCalendarMacroCall(
    { location: event.location },
    calendarMacroCallUrl(event)
  ).location.trim();
}

/** Attach one invitation link without replacing a physical location or notes. */
export function attachCalendarMacroCall(
  content: Pick<CalendarCallContent, 'description' | 'location'>,
  url: string,
  existingUrl?: string
) {
  const clean = removeCalendarMacroCall(content, existingUrl ?? url);
  return {
    description: `${clean.description}${clean.description ? '\n' : ''}<p>${CALL_LINK_LABEL}: <a href="${url}">${url}</a></p>`,
    location: clean.location.trim() ? clean.location : url,
  };
}
