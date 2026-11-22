import { PRODUCT_NAME } from '@app/lib/constants/product';
import { ConfirmDialog } from '@ui';

export type DisconnectConfirm = {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
};

export function DisconnectConfirmDialog(props: {
  request: DisconnectConfirm | null;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={props.request?.title ?? `Disconnect from ${PRODUCT_NAME}`}
      body={props.request?.body}
      confirmLabel={props.request?.confirmLabel ?? 'Disconnect'}
      tone="danger"
      onConfirm={() => {
        const request = props.request;
        if (!request) return;
        props.onClose();
        request.onConfirm();
      }}
    />
  );
}
