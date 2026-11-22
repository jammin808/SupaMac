import { InlineTitleEditor } from '@core/component/InlineTitleEditor';
import { Show } from 'solid-js';

/**
 * A record's name, edited in place.
 *
 * `InlineTitleEditor` forgets what was typed as soon as it commits, so a
 * rejected rename types the name back into the field: it stays on screen,
 * Enter or leaving the field tries it again, and Escape drops it. The editor
 * is keyed by record so an unsaved name never follows the view to another
 * record.
 */
export function RecordTitle(props: {
  recordId: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  /** Starts the rename; `onError` runs when the server rejects it. */
  rename(name: string, onError: () => void): void;
}) {
  return (
    <Show when={props.recordId} keyed>
      {(_recordId) => {
        let field: HTMLSpanElement | undefined;
        let latestName: string | undefined;

        const typeBack = (name: string) => {
          const input = field?.querySelector('input');
          if (!input?.isConnected || latestName !== name) return;

          // Text the person has typed since then outranks the rejected name.
          if (input.value !== props.value) return;

          input.value = name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        return (
          <span ref={field} class="contents">
            <InlineTitleEditor
              value={props.value}
              placeholder={props.placeholder}
              ariaLabel={props.ariaLabel}
              class="w-full text-2xl"
              onRename={(name) => {
                latestName = name;
                props.rename(name, () => typeBack(name));
              }}
            />
          </span>
        );
      }}
    </Show>
  );
}
