import { LoginButton } from '@core/component/TopBar/LoginButton';
import { SELF_HOSTED } from '@core/constant/servers';
import { Surface } from '@ui';
import { Show } from 'solid-js';

export default function Banner() {
  return (
    <div class="fixed bottom-[var(--safe-bottom,0px)] md:bottom-12 md:left-1/2 md:-translate-x-1/2 z-sign-up-banner w-full md:w-auto">
      <Surface>
        <div class="flex md:flex-row flex-col justify-baseline items-center gap-2 md:gap-6 p-2 text-ink text-center whitespace-nowrap">
          {/* A self-hosted instance admits only the addresses its owner allows. */}
          <Show when={!SELF_HOSTED}>
            <span class="text-sm text-ink-muted px-2">
              Create an account to get started.
            </span>
          </Show>
          <LoginButton />
        </div>
      </Surface>
    </div>
  );
}
