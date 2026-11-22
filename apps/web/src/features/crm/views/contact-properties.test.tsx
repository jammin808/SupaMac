import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import type { CrmContact } from '../core/contact';

const state = vi.hoisted(() => ({
  companyReads: [] as string[],
  writeClipboardData: vi.fn(),
  feedback: { success: vi.fn(), failure: vi.fn() },
}));

vi.mock('../context/crm-context', () => ({
  useCrmContext: () => ({
    createNavigation: () => ({ openWithSplit: vi.fn() }),
    editContactCompany: () => ({ mutateAsync: vi.fn() }),
    editContactEmail: () => ({ mutateAsync: vi.fn() }),
    feedback: state.feedback,
  }),
}));
vi.mock('@core/util/dataTransfer', () => ({
  writeClipboardData: state.writeClipboardData,
}));
vi.mock('./use-crm', () => ({
  useCompanyQuery: (id: () => string) => ({
    company: () => {
      const companyId = id();
      if (!companyId) return undefined;
      state.companyReads.push(companyId);
      return { id: companyId, name: 'Read company' };
    },
  }),
}));
vi.mock('../components/contact-company-property', () => ({
  ContactCompanyProperty: (props: { companyName?: string }) => (
    <span>{props.companyName ?? 'no company name'}</span>
  ),
}));
vi.mock('../components/contact-email-property', () => ({
  ContactEmailProperty: (props: {
    emails: string[];
    copy(email: string): Promise<boolean>;
  }) => (
    <button type="button" onClick={() => props.copy(props.emails[0] ?? '')}>
      Copy first address
    </button>
  ),
}));

import { ContactCompanyField, ContactEmailField } from './contact-properties';

afterEach(() => {
  cleanup();
  state.companyReads = [];
  state.writeClipboardData.mockReset();
  state.feedback.success.mockReset();
  state.feedback.failure.mockReset();
});

function contact(company?: CrmContact['company']): CrmContact {
  return {
    id: 'contact-1',
    companyId: 'company-1',
    company,
    hidden: false,
    firstInteraction: '',
    lastInteraction: '',
    createdAt: '',
    updatedAt: '',
  };
}

it('names the company from the contact detail without reading it', () => {
  render(() => (
    <ContactCompanyField
      contact={contact({ id: 'company-1', name: 'Acme', hidden: false })}
    />
  ));
  expect(screen.getByText('Acme')).toBeTruthy();
  expect(state.companyReads).toEqual([]);
});

it('names an unnamed company by its domain', () => {
  render(() => (
    <ContactCompanyField
      contact={contact({
        id: 'company-1',
        name: null,
        domain: 'acme.com',
        hidden: false,
      })}
    />
  ));
  expect(screen.getByText('acme.com')).toBeTruthy();
  expect(state.companyReads).toEqual([]);
});

it('reads the company for a detail without a summary', () => {
  render(() => <ContactCompanyField contact={contact()} />);
  expect(screen.getByText('Read company')).toBeTruthy();
  expect(state.companyReads).toContain('company-1');
});

it("copies a contact's address and confirms it", async () => {
  state.writeClipboardData.mockResolvedValue(true);
  render(() => (
    <ContactEmailField
      contact={{ ...contact(), email: 'person@example.com' }}
    />
  ));

  fireEvent.click(screen.getByRole('button', { name: 'Copy first address' }));

  await vi.waitFor(() =>
    expect(state.feedback.success).toHaveBeenCalledExactlyOnceWith('Copied')
  );
  expect(state.writeClipboardData).toHaveBeenCalledExactlyOnceWith({
    'text/plain': 'person@example.com',
  });
  expect(state.feedback.failure).not.toHaveBeenCalled();
});

it('reports an address the clipboard refused', async () => {
  state.writeClipboardData.mockResolvedValue(false);
  render(() => (
    <ContactEmailField
      contact={{ ...contact(), email: 'person@example.com' }}
    />
  ));

  fireEvent.click(screen.getByRole('button', { name: 'Copy first address' }));

  await vi.waitFor(() =>
    expect(state.feedback.failure).toHaveBeenCalledExactlyOnceWith(
      'Unable to copy item'
    )
  );
  expect(state.feedback.success).not.toHaveBeenCalled();
});
