import { SELF_HOSTED } from '@core/constant/selfHosted';
import { hasLoginCookie } from '@core/util/cookies';
import { createSignal } from 'solid-js';

// The hosted service's preview hosts share HttpOnly dev auth cookies on
// .macro.com, but not the host-only login hint or localStorage from
// dev.macro.com. Probe identity there even without a hint; account services
// still require confirmed authentication. A self-hosted instance has no
// preview hosts, so only its login hint starts the probe.
const [shouldQueryUserInfo, setShouldQueryUserInfo] = createSignal(
  hasLoginCookie() ||
    (!SELF_HOSTED &&
      typeof window !== 'undefined' &&
      window.location.hostname.endsWith('.preview.macro.com'))
);

export { shouldQueryUserInfo };

export function enableUserInfoQuery() {
  setShouldQueryUserInfo(true);
}

// A login popup or sibling tab updates the shared login marker. It is only a
// hint to check identity, never proof that account services may start.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', () => {
    if (hasLoginCookie()) enableUserInfoQuery();
  });
}
