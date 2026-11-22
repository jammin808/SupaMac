import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachCalendarMacroCall,
  calendarMacroCallUrl,
  macroCallUrl,
  removeCalendarMacroCall,
} from './macro-call-link';

const URL = 'https://macro.com/app/meet/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF';
const SETUP_URL = URL.replace('/meet/', '/meet/join/');

describe('Macro calendar call links', () => {
  it('recognizes shared links in invitations and drops autojoin parameters', () => {
    expect(
      calendarMacroCallUrl({
        description: `<p>Join <a href="${URL}?join=true&amp;source=calendar">the call</a></p>`,
      })
    ).toBe(URL);
    expect(
      macroCallUrl(
        'http://localhost:3003/app/meet/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF'
      )
    ).toBe('http://localhost:3003/app/meet/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF');
  });

  it('recognizes setup links and UUID links alongside saved legacy invitations', () => {
    for (const url of [
      SETUP_URL,
      'https://macro.com/app/meet/join/01955c94-2576-7f3a-9d60-173d74b7f812',
      'https://macro.com/meet/join/01955c94-2576-7f3a-9d60-173d74b7f812',
      URL,
    ]) {
      expect(
        calendarMacroCallUrl({ location: `${url}/?source=calendar` })
      ).toBe(url);
    }
  });

  it('rejects lookalike sites, credentials, unsafe protocols and malformed routes', () => {
    for (const candidate of [
      URL.replace('macro.com', 'macro.com.evil.test'),
      URL.replace('macro.com', 'macro.com@evil.test'),
      URL.replace('https:', 'javascript:'),
      URL.replace('https:', 'http:'),
      `${URL}/extra`,
      'https://macro.com/app/meet/short',
      'https://macro.com/app/meet/new',
      'https://macro.com/app/meet/join',
      'https://macro.com/app/meet/join/short',
      `${SETUP_URL}/extra`,
    ]) {
      expect(macroCallUrl(candidate)).toBeUndefined();
    }
  });

  it('keeps notes and a physical room while adding a portable invitation link', () => {
    const content = attachCalendarMacroCall(
      {
        description: '<p>Bring the roadmap.</p>',
        location: 'Room 2',
      },
      URL
    );
    expect(content.location).toBe('Room 2');
    expect(content.description).toContain('<p>Bring the roadmap.</p>');
    expect(content.description).toContain(`<a href="${URL}">${URL}</a>`);
    expect(calendarMacroCallUrl(content)).toBe(URL);
  });

  it('does not duplicate the generated link when saving an existing or recurring call', () => {
    const initial = attachCalendarMacroCall(
      { description: '<p>Notes</p>' },
      URL
    );
    expect(attachCalendarMacroCall(initial, URL)).toEqual(initial);
    expect(removeCalendarMacroCall(initial, URL)).toEqual({
      description: '<p>Notes</p>',
      location: '',
    });
  });

  it('replaces a generated legacy invitation with the setup link without losing notes', () => {
    const legacy = attachCalendarMacroCall(
      { description: '<p>Notes</p>' },
      URL
    );
    const updated = attachCalendarMacroCall(legacy, SETUP_URL, URL);
    expect(updated.location).toBe(SETUP_URL);
    expect(calendarMacroCallUrl(updated)).toBe(SETUP_URL);
    expect(removeCalendarMacroCall(updated, SETUP_URL)).toEqual({
      description: '<p>Notes</p>',
      location: '',
    });
  });

  it('hides a generated invitation with tracking parameters in its displayed URL', () => {
    const trackedUrl = `${URL}?join=true&amp;source=calendar`;
    expect(
      removeCalendarMacroCall(
        {
          description: `<p>Agenda</p><p>Join Macro call: <a href="${trackedUrl}">${trackedUrl}</a></p>`,
          location: 'Room 2',
        },
        URL
      )
    ).toEqual({ description: '<p>Agenda</p>', location: 'Room 2' });
  });

  it('hides generated Macro invitations even when the series URL differs', () => {
    expect(
      removeCalendarMacroCall(
        {
          description: `<p>Join Macro call: <a href="${SETUP_URL}">${SETUP_URL}</a></p>`,
          location: 'Room 2',
        },
        URL
      ).description
    ).toBe('');
  });

  it('preserves independently authored call links and other description content', () => {
    const content = {
      description: `<p>Related call: <a href="${URL}">prior discussion</a></p>`,
      location: 'Room 2',
    };
    expect(removeCalendarMacroCall(content, URL)).toEqual(content);
  });

  it('writes the join line under the label the calendar service strips, and clears either wording', () => {
    const attached = attachCalendarMacroCall(
      { description: '', location: '' },
      URL
    );
    // The service leaves this paragraph out of shares by its exact label
    // (JOIN_LINE_LABEL in crates/calendar_events/src/domain/meeting_links.rs).
    expect(attached.description).toBe(
      `<p>Join SupaMac call: <a href="${URL}">${URL}</a></p>`
    );
    expect(removeCalendarMacroCall(attached, URL).description).toBe('');

    // The hosted product's wording, which stored events carry, is generated
    // text too.
    expect(
      removeCalendarMacroCall(
        {
          description: `<p>Notes</p><p>join macro call: ${URL}</p>`,
          location: '',
        },
        URL
      ).description
    ).toBe('<p>Notes</p>');
  });
});

// A deployment served from its own host and folder shares meeting links under
// both, so an event must recognize exactly those as its Macro call.
describe('Macro calendar call links under another base path', () => {
  afterEach(() => {
    vi.doUnmock('@core/util/webOrigin');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('recognizes the links the deployment shares, on its own origin and base only', async () => {
    vi.stubEnv('__APP_BASE_PATH__', '/workspace');
    vi.doMock('@core/util/webOrigin', () => ({
      getWebOrigin: () => 'https://example.com',
    }));
    vi.resetModules();
    const { getMeetingUrl } = await import('@channel/Call/call-link');
    const { macroCallUrl } = await import('./macro-call-link');

    const shared = getMeetingUrl('8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF');

    expect(shared).toBe(
      'https://example.com/workspace/meet/join/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF'
    );
    expect(macroCallUrl(shared)).toBe(shared);
    expect(
      macroCallUrl(shared.replace('example.com', 'other.example'))
    ).toBeUndefined();
    expect(macroCallUrl(shared.replace('/workspace', '/app'))).toBeUndefined();
  });
});

// A self-hosted instance's calls are its own: an invitation from the hosted
// product is not a way into one of them.
describe('Macro calendar call links on a self-hosted instance', () => {
  afterEach(() => {
    vi.doUnmock('@core/constant/servers');
    vi.doUnmock('@core/util/webOrigin');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('recognizes its own and local links, and none of the hosted product', async () => {
    vi.stubEnv('__APP_BASE_PATH__', '/supamac');
    vi.doMock('@core/constant/servers', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@core/constant/servers')>()),
      SELF_HOSTED: true,
    }));
    vi.doMock('@core/util/webOrigin', () => ({
      getWebOrigin: () => 'https://ui.example.org',
    }));
    vi.resetModules();
    const { calendarMacroCallUrl, macroCallUrl, removeCalendarMacroCall } =
      await import('./macro-call-link');

    const own =
      'https://ui.example.org/supamac/meet/join/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF';
    expect(macroCallUrl(own)).toBe(own);
    expect(
      macroCallUrl(
        'http://localhost:3003/supamac/meet/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF'
      )
    ).toBe(
      'http://localhost:3003/supamac/meet/8m8mGwzHqxzYjeIN5-nJRquRbzyTEhGF'
    );
    for (const hosted of [
      URL,
      SETUP_URL,
      URL.replace('https://macro.com/app', 'https://macro.com/supamac'),
      URL.replace('https://macro.com/app', 'https://dev.macro.com/supamac'),
    ]) {
      expect(macroCallUrl(hosted)).toBeUndefined();
      expect(calendarMacroCallUrl({ location: hosted })).toBeUndefined();
    }

    // The hosted product's wording still marks a generated paragraph.
    expect(
      removeCalendarMacroCall(
        {
          description: `<p>Notes</p><p>Join Macro call: <a href="${own}">${own}</a></p>`,
          location: '',
        },
        own
      ).description
    ).toBe('<p>Notes</p>');
  });
});
