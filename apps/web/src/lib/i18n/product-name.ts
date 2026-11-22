import { PRODUCT_NAME } from '@app/lib/constants/product';
import type { TranslationKey } from './dictionary';
import type { Language } from './languages';

/**
 * The name the message catalogs call the product by. The catalogs are kept as
 * the upstream project writes them, so every message is shown through
 * {@link withProductName}, which puts {@link PRODUCT_NAME} in its place.
 */
const CATALOG_NAME = 'Macro';

/**
 * The catalog name as a whole word. `\b` counts only ASCII letters, digits and
 * `_` as word characters, so the name also matches where text in another
 * script touches it (Japanese `Macroの`), and not inside `MacroD`.
 */
const CATALOG_NAME_WORD = /\bMacro\b/g;

const STORE_LISTING =
  'Names the mobile app as its app store listing does; that app is published by the upstream project.';

/**
 * Messages that keep the catalog name because it is not this product there,
 * each with the reason. The translation tests fail for any other message that
 * still shows it.
 */
export const KEPT_CATALOG_NAME: Partial<Record<TranslationKey, string>> = {
  'agentSetup.productDocs':
    'Labels a link to the documentation site of the upstream project.',
  'settingsMobileApp.scanDescription': STORE_LISTING,
  'settingsMobileApp.storeLinksDescription': STORE_LISTING,
  'settingsMobileApp.appStoreDescription': STORE_LISTING,
  'settingsMobileApp.googlePlayDescription': STORE_LISTING,
  'settingsMobileApp.appStorePrompt': STORE_LISTING,
  'settingsMobileApp.googlePlayPrompt': STORE_LISTING,
};

/**
 * Inflected forms of the catalog name, which the whole-word rule does not
 * match, each with the same form of the product name. A language that joins an
 * ending to the name needs its forms here; the translation tests name any
 * that are missing. Finnish links an ending to a final consonant with `i`.
 */
const INFLECTED_NAMES: Partial<
  Record<Language, readonly (readonly [form: RegExp, named: string])[]>
> = {
  da: [[/\bMacros\b/g, `${PRODUCT_NAME}s`]],
  sv: [[/\bMacros\b/g, `${PRODUCT_NAME}s`]],
  fi: [
    [/\bMacron\b/g, `${PRODUCT_NAME}in`],
    [/\bMacrosta\b/g, `${PRODUCT_NAME}ista`],
  ],
};

/**
 * `template` with the product's name where the catalog names the product.
 * It runs on the message before its placeholders are filled, so a value that
 * happens to contain the catalog name (a document title, a person) is left
 * alone. `language` is the language the message is written in.
 */
export function withProductName(
  template: string,
  key: TranslationKey,
  language: Language
): string {
  if (!template.includes(CATALOG_NAME)) return template;
  if (key in KEPT_CATALOG_NAME) return template;

  let named = template.replace(CATALOG_NAME_WORD, PRODUCT_NAME);
  for (const [form, inflected] of INFLECTED_NAMES[language] ?? []) {
    named = named.replace(form, inflected);
  }
  return named;
}
