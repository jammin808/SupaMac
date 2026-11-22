import { Button } from '@ui';

/**
 * Names a limit the server refused on, with nothing to buy: what a
 * self-hosted instance shows in place of the plans.
 */
export function LimitNotice(props: { title: string; onDismiss: () => void }) {
  return (
    <section class="flex w-full flex-col gap-6 p-6 sm:p-8">
      <h2 class="text-2xl font-semibold text-ink">{props.title}</h2>
      <footer class="flex justify-end border-t border-edge-muted pt-4">
        <Button size="sm" variant="primary" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </footer>
    </section>
  );
}
