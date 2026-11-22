import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageContext } from './context/usage-context';
import { Usage } from './usage';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

const settings = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@core/constant/SettingsState', () => ({
  useSettingsState: () => settings,
}));

vi.mock('@queries/auth', () => {
  const query = () => ({
    isSuccess: false,
    isPending: true,
    isError: false,
    refetch: async () => undefined,
  });
  const mutation = () => ({
    isPending: false,
    mutateAsync: async () => undefined,
  });
  return {
    useAiBillingSummaryQuery: query,
    useAiBillingPlansQuery: query,
    usePurchaseAiCreditsMutation: mutation,
    useCreateAiCreditCheckoutMutation: mutation,
    useCreateBillingPortalMutation: mutation,
    useUpdateAiOverageMutation: mutation,
    useUpdateAiAutoReloadMutation: mutation,
  };
});

const view = vi.hoisted(() => ({
  context: undefined as UsageContext | undefined,
}));
vi.mock('./views/usage-settings', () => ({
  UsageSettingsView: (props: { context: UsageContext }) => {
    view.context = props.context;
    return null;
  },
}));

beforeEach(() => {
  build.selfHosted = false;
  settings.openSettings.mockClear();
  view.context = undefined;
});
afterEach(cleanup);

describe('the Usage page asking for the plans', () => {
  it('opens Billing on the hosted service', () => {
    render(() => <Usage />);
    view.context?.openPlans();

    expect(settings.openSettings).toHaveBeenCalledWith('Billing');
  });

  it('opens nothing on a self-hosted instance, which has no plans page', () => {
    build.selfHosted = true;
    render(() => <Usage />);
    view.context?.openPlans();

    expect(view.context).toBeDefined();
    expect(settings.openSettings).not.toHaveBeenCalled();
  });
});
