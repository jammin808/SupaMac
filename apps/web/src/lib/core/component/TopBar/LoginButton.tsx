import { WEB_BASE_PATH } from '@app/constants/routerBase';
import { useIsAuthenticated } from '@core/auth';
import { SELF_HOSTED } from '@core/constant/servers';
import { useNavigate } from '@solidjs/router';
import { Button } from '@ui';
import { Show } from 'solid-js';

export function openLoginModal() {
  const isAuthenticated = useIsAuthenticated();
  if (isAuthenticated()) return;

  const params = new URLSearchParams(window.location.search);
  const queryString = params.size > 0 ? `?${params.toString()}` : '';
  window.location.href = `${window.location.origin}${WEB_BASE_PATH}/login${queryString}`;
}

export function LoginButton() {
  const navigate = useNavigate();
  return (
    <div class="flex gap-2 justify-center w-max items-center">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => navigate(`/login${window.location.search}`)}
      >
        Login
      </Button>
      {/* A self-hosted instance admits only the addresses its owner allows. */}
      <Show when={!SELF_HOSTED}>
        <span class="text-xs text-ink-muted italic">or</span>
        <Button
          variant="primary"
          size="sm"
          onClick={() => navigate(`/welcome${window.location.search}`)}
        >
          Sign Up
        </Button>
      </Show>
    </div>
  );
}
