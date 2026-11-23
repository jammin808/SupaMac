import { describe, expect, it } from 'vitest';
import type {
  PartialDictionary,
  PluralMessage,
  TranslationKey,
} from './dictionary';
import { formatMessage, lookupMessage, pluralForm } from './dictionary';
import {
  browserLanguage,
  LANGUAGES,
  Language,
  resolveInterfaceLanguage,
} from './languages';
import en from './locales/en';
import { KEPT_CATALOG_NAME, withProductName } from './product-name';

const translations = import.meta.glob<{ default: PartialDictionary }>(
  './locales/*.ts',
  { eager: true }
);

function translationFor(code: Language): PartialDictionary {
  const module = translations[`./locales/${code}.ts`];
  if (!module) throw new Error(`No translation file for ${code}`);
  return module.default;
}

type Message = string | PluralMessage;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** The name the catalogs call the product by, in any inflection or case. */
const CATALOG_NAME = /macro/i;

/**
 * Names that contain the catalog name and are not it, each with the reason
 * it stays as written.
 */
const OTHER_NAMES = [
  {
    name: /macrod/gi,
    reason: 'The command-line program people install and run under this name.',
  },
];

/** Every message of a catalog as `namespace.message` and its text. */
function messagesOf(catalog: PartialDictionary): [TranslationKey, Message][] {
  const all: [TranslationKey, Message][] = [];
  for (const [namespace, messages] of Object.entries(catalog)) {
    for (const [message, text] of Object.entries(messages ?? {})) {
      if (text === undefined) continue;
      all.push([`${namespace}.${message}` as TranslationKey, text]);
    }
  }
  return all;
}

function texts(message: Message): string[] {
  return typeof message === 'string'
    ? [message]
    : Object.values(message).filter((text) => text !== undefined);
}

/** Every placeholder the message uses in any of its forms. */
function placeholders(message: Message): string[] {
  return [
    ...new Set(
      texts(message).flatMap((text) =>
        [...text.matchAll(PLACEHOLDER)].map((match) => match[1])
      )
    ),
  ].sort();
}

describe('resolveInterfaceLanguage', () => {
  it('prefers the person, then the team, then the browser, then English', () => {
    expect(
      resolveInterfaceLanguage(Language.ja, Language.de, Language.fr)
    ).toBe('ja');
    expect(resolveInterfaceLanguage(null, Language.de, Language.fr)).toBe('de');
    expect(resolveInterfaceLanguage(null, null, Language.fr)).toBe('fr');
    expect(resolveInterfaceLanguage(undefined, undefined, undefined)).toBe(
      'en'
    );
  });
});

describe('browserLanguage', () => {
  it('takes the first offered language, by language and script', () => {
    expect(browserLanguage(['de-AT', 'en'])).toBe('de');
    expect(browserLanguage(['fr-CA'])).toBe('fr');
    expect(browserLanguage(['zh-TW'])).toBe('zh-Hant');
    expect(browserLanguage(['zh-CN'])).toBe('zh-Hans');
    expect(browserLanguage(['zh'])).toBe('zh-Hans');
    expect(browserLanguage(['pt-BR'])).toBe('pt-PT');
    expect(browserLanguage(['no'])).toBe('nb');
  });

  it('skips languages it is not offered in, and stops at English', () => {
    expect(browserLanguage(['ar', 'he', 'it'])).toBe('it');
    expect(browserLanguage(['en-GB', 'de'])).toBe('en');
    expect(browserLanguage(['ar'])).toBeUndefined();
    expect(browserLanguage(['not a tag'])).toBeUndefined();
  });
});

describe('formatMessage', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(formatMessage('Go to {{label}}', { label: 'Email' })).toBe(
      'Go to Email'
    );
    expect(formatMessage('{{ count }} of {{total}}', { count: 2 })).toBe(
      '2 of {{total}}'
    );
  });

  it('writes numbers for the locale', () => {
    expect(formatMessage('{{count}} items', { count: 1234 }, 'de')).toBe(
      '1.234 items'
    );
    expect(formatMessage('{{count}} items', { count: 1234 }, 'en')).toBe(
      '1,234 items'
    );
  });
});

describe('pluralForm', () => {
  const files = {
    one: '{{count}} plik',
    few: '{{count}} pliki',
    many: '{{count}} plików',
    other: '{{count}} pliku',
  };

  it('picks the form for the count in the language', () => {
    expect(pluralForm(files, 1, 'pl')).toBe('{{count}} plik');
    expect(pluralForm(files, 3, 'pl')).toBe('{{count}} pliki');
    expect(pluralForm(files, 5, 'pl')).toBe('{{count}} plików');
    expect(pluralForm(files, 22, 'pl')).toBe('{{count}} pliki');
  });

  it('falls back to the other form', () => {
    expect(pluralForm({ other: 'x' }, 1, 'en')).toBe('x');
  });
});

describe('lookupMessage', () => {
  it('falls through when a translation leaves a key out', () => {
    expect(lookupMessage({}, 'common.cancel')).toBeUndefined();
    expect(lookupMessage(en, 'common.cancel')).toBe('Cancel');
  });
});

describe('translations', () => {
  it('has a file for every language and nothing else', () => {
    const files = Object.keys(translations)
      .map((path) => path.replace('./locales/', '').replace('.ts', ''))
      .sort();
    expect(files).toEqual(LANGUAGES.map(({ code }) => code).sort());
  });

  // Missing and out-of-date translations fall back to English and are filled
  // in by the translation update (`bun run i18n:status`); these are the
  // mistakes that would show wrong text.
  it.each(
    LANGUAGES.filter(({ code }) => code !== 'en').map(({ code }) => code)
  )(
    '%s only translates English messages, with their placeholders and plural forms',
    (code) => {
      const translation = translationFor(code);
      const categories = new Intl.PluralRules(code).resolvedOptions()
        .pluralCategories;
      const stray: string[] = [];
      const mismatched: string[] = [];
      const wrongForms: string[] = [];
      for (const [namespace, messages] of Object.entries(translation)) {
        for (const [message, translated] of Object.entries(messages ?? {})) {
          const key = `${namespace}.${message}`;
          const english = (
            en[namespace as keyof typeof en] as
              | Record<string, Message>
              | undefined
          )?.[message];
          if (english === undefined || translated === undefined) {
            stray.push(key);
            continue;
          }
          if (
            placeholders(translated).join() !== placeholders(english).join()
          ) {
            mismatched.push(key);
          }
          // A plural message stays plural, with exactly the language's forms.
          const forms =
            typeof translated === 'string'
              ? []
              : Object.keys(translated).sort();
          const expected =
            typeof english === 'string' ? [] : [...categories].sort();
          if (forms.join() !== expected.join()) wrongForms.push(key);
        }
      }
      expect(stray).toEqual([]);
      expect(mismatched).toEqual([]);
      expect(wrongForms).toEqual([]);
    }
  );
});

describe('the product name', () => {
  it('replaces the catalog name as a whole word, before placeholders are filled', () => {
    expect(withProductName('Ask Macro', 'channelComposer.askMacro', 'en')).toBe(
      'Ask SupaMac'
    );
    expect(
      withProductName(
        'Picked for you, and Macro’s templates. Open {{name}} in Macro.',
        'routineSuggestions.discoverHint',
        'en'
      )
    ).toBe(
      'Picked for you, and SupaMac’s templates. Open {{name}} in SupaMac.'
    );
    expect(
      withProductName(
        'Macroの新しいバージョン',
        'nav.updateWebDescription',
        'ja'
      )
    ).toBe('SupaMacの新しいバージョン');
    expect(
      withProductName('Learn how to use MacroD', 'tutorials.macrodTitle', 'en')
    ).toBe('Learn how to use MacroD');
  });

  it('inflects the product name as the language inflected the catalog name', () => {
    expect(
      withProductName('Macron uusi versio', 'nav.updateWebDescription', 'fi')
    ).toBe('SupaMacin uusi versio');
    expect(
      withProductName(
        'Osaa Macrosta ei voitu ladata',
        'nav.updateWebFailedLoadDescription',
        'fi'
      )
    ).toBe('Osaa SupaMacista ei voitu ladata');
    expect(
      withProductName(
        'Macros skrivbordsapp',
        'nav.updateBundleDescription',
        'sv'
      )
    ).toBe('SupaMacs skrivbordsapp');
  });

  it('keeps the catalog name only in messages that name something else', () => {
    const english = new Map(messagesOf(en));
    for (const [key, reason] of Object.entries(KEPT_CATALOG_NAME)) {
      const message = english.get(key as TranslationKey);
      expect(message, key).toBeDefined();
      expect(reason, key).toBeTruthy();
      for (const text of texts(message ?? '')) {
        expect(text, key).toMatch(CATALOG_NAME);
        expect(withProductName(text, key as TranslationKey, 'en')).toBe(text);
      }
    }
  });

  it.each(LANGUAGES.map(({ code }) => code))(
    '%s shows the catalog name in no other message',
    (code) => {
      const shown: string[] = [];
      for (const [key, message] of messagesOf(translationFor(code))) {
        if (key in KEPT_CATALOG_NAME) continue;
        for (const text of texts(message)) {
          const resolved = withProductName(text, key, code);
          const withoutOtherNames = OTHER_NAMES.reduce(
            (rest, { name }) => rest.replace(name, ''),
            resolved
          );
          if (CATALOG_NAME.test(withoutOtherNames)) {
            shown.push(`${key}: ${resolved}`);
          }
        }
      }
      expect(shown).toEqual([]);
    }
  );
});
