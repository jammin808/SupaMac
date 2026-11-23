import { useHasPaidAccess } from '@core/auth/license';
import { SELF_HOSTED } from '@core/constant/servers';
import type { Accessor } from 'solid-js';

/**
 * The composer's paid access: without it, mail goes out with the free plan's
 * watermark and the composer offers an upgrade that removes it. A self-hosted
 * instance sells no plan, so its mail never carries the watermark whatever
 * license its server reports. Limits the server enforces (AI models, storage,
 * inboxes) still follow `useHasPaidAccess`.
 */
export function useComposePaidAccess(): Accessor<boolean> {
  if (SELF_HOSTED) return () => true;
  return useHasPaidAccess();
}
