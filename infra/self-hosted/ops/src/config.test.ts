// FusionAuth applies the kickstart once and cannot be asked to try again, so
// a mistake in it is found here, when the image is built.

import { file } from 'bun';
import { expect, test } from 'bun:test';

const kickstartPath = new URL(
  '../config/fusionauth/kickstart.json',
  import.meta.url
);

test('every variable the kickstart uses is defined, and every secret comes from the environment', async () => {
  const text = await file(kickstartPath).text();
  const kickstart = JSON.parse(text);
  const variables: Record<string, string> = kickstart.variables;

  const requests = JSON.stringify([kickstart.apiKeys, kickstart.requests]);
  const used = [...requests.matchAll(/#\{([^}]+)\}/g)].map((match) => match[1]);
  const undefinedVariables = used.filter((name) => !(name in variables));
  expect(undefinedVariables).toEqual([]);

  const fixed = Object.entries(variables)
    .filter(([, value]) => !/^#\{ENV\.[A-Z_]+\}$/.test(value))
    .map(([name]) => name);
  expect(fixed).toEqual(['defaultTenantId']);
});

test('the admin account is created before the webhooks that would roll it back', async () => {
  const kickstart = JSON.parse(await file(kickstartPath).text());
  const urls: string[] = kickstart.requests.map(
    (request: { url: string }) => request.url
  );

  const adminUser = urls.indexOf('/api/user/registration');
  const firstWebhook = urls.indexOf('/api/webhook');

  expect(adminUser).toBeGreaterThan(-1);
  expect(firstWebhook).toBeGreaterThan(adminUser);
});
