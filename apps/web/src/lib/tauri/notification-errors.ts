import { PRODUCT_NAME } from '@app/lib/constants/product';

// Keep the existing class name for callers; both desktop senders use this error.
export class MacOSNotificationUpdateRequiredError extends Error {
  constructor(cause: unknown) {
    super(`Update ${PRODUCT_NAME} to receive desktop notifications.`, {
      cause,
    });
    this.name = 'MacOSNotificationUpdateRequiredError';
  }
}
