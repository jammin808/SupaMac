import { isTouchDevice } from '@core/mobile/isTouchDevice';
import { onCleanup } from 'solid-js';

/**
 * A People row's address, which a pointer can select and copy. The row drags
 * on a press and opens on a click, so a press that starts on the address stays
 * with it, and the click that ends a selection of it does not open the row. A
 * plain click on the address still does. Touch rows keep the press for their
 * own gestures.
 */
export function ContactRowEmail(props: { email: string }) {
  let endWatch: (() => void) | undefined;
  onCleanup(() => endWatch?.());

  // The click that ends a drag is sent to the nearest element holding both the
  // press and the release, which is the row once the pointer leaves the
  // address. It is caught at the window, ahead of every handler, and only for
  // this press: the next press or key ends the watch.
  const holdSelectingClick = (address: HTMLElement) => {
    endWatch?.();

    const onClick = (click: MouseEvent) => {
      stop();
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      if (!address.contains(selection.anchorNode)) return;
      click.stopPropagation();
    };
    const stop = () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
      endWatch = undefined;
    };

    window.addEventListener('click', onClick, true);
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', stop, true);
    endWatch = stop;
  };

  return (
    <span
      class="truncate shrink-[2] min-w-0 text-xs font-normal text-ink-extra-muted not-touch:cursor-text not-touch:select-text"
      // The drag sensor listens on the row element, ahead of delegated handlers.
      on:mousedown={(event) => {
        if (isTouchDevice()) return;
        event.stopPropagation();
        if (event.button === 0) holdSelectingClick(event.currentTarget);
      }}
    >
      {props.email}
    </span>
  );
}
