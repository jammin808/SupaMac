import { describe, expect, test } from 'bun:test';
import { ExtractError } from '../../src/text/types';
import {
  checkXml,
  decodeEntities,
  elements,
  parseXml,
  textOf,
} from '../../src/text/xml';

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ExtractError) return error.kind;
    throw error;
  }
  return 'none';
}

describe('parseXml', () => {
  test('decodes the predefined entities and numeric references, and nothing else', () => {
    expect(
      decodeEntities(
        'Fish &amp; chips &#163;5 &#x20AC;6 &lt;b&gt; &quot;x&quot; &apos;y&apos;'
      )
    ).toBe('Fish & chips £5 €6 <b> "x" \'y\'');
    expect(decodeEntities('&lol; &#0; &#xD800;')).toBe('&lol; &#0; &#xD800;');
    const root = parseXml(
      '<a b="1 &lt; 2">Rate &amp; fee<![CDATA[ &amp; raw ]]></a>',
      256
    );
    expect(root.attrs.b).toBe('1 < 2');
    expect(textOf(root)).toBe('Rate & fee &amp; raw ');
  });

  test('refuses a DOCTYPE, so entity expansion never starts', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><a>&lol2;</a>`;
    expect(kindOf(() => parseXml(laughs, 256))).toBe('hostile_xml');
    const external = `<?xml version="1.0"?><!DOCTYPE a SYSTEM "file:///etc/passwd"><a>x</a>`;
    expect(kindOf(() => parseXml(external, 256))).toBe('hostile_xml');
  });

  test('refuses nesting deeper than the limit, measured before parsing', () => {
    const deep = `${'<a>'.repeat(5000)}x${'</a>'.repeat(5000)}`;
    expect(kindOf(() => parseXml(deep, 256))).toBe('hostile_xml');
    const fine = `${'<a>'.repeat(200)}x${'</a>'.repeat(200)}`;
    expect(checkXml(fine, 256)).toBe(200);
    expect(textOf(parseXml(fine, 256))).toBe('x');
  });

  test('refuses more elements than the limit as too large, counted before parsing', () => {
    const many = `<sst>${'<si><t>a</t></si>'.repeat(60)}</sst>`;
    expect(kindOf(() => parseXml(many, 256, 100))).toBe('too_large');
    expect(kindOf(() => parseXml(many, 256, 121))).toBe('none');
    expect(kindOf(() => checkXml('<a><b/><b/><b/></a>', 256, 3))).toBe(
      'too_large'
    );
  });

  test('is not misled by ">" in attribute values, comments or self-closing tags', () => {
    expect(
      checkXml('<a x="1>2"><b/><!-- <c> --><d y=\'>\'></d></a>', 256)
    ).toBe(2);
    const root = parseXml('<a><b/><c>t</c></a>', 256);
    expect(elements(root).map((e) => e.name)).toEqual(['b', 'c']);
  });
});
