import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./use-crm', () => ({
  useCreateCompanyMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useCreateContactMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useQuickAccessCrmCompaniesQuery: () => ({
    companies: () => [],
    query: { isLoading: false },
  }),
}));

import { PipelineDialog } from '../components/pipeline-dialog';
import { CreateCompanyModal } from './create-company';
import { CreateContactModal } from './create-contact';

// The dialog's scroll lock restores the page position as it closes.
beforeEach(() => vi.stubGlobal('scrollTo', vi.fn()));
afterEach(cleanup);

it('names each field of a new contact with a visible label', () => {
  render(() => (
    <CreateContactModal target={{}} onClose={() => {}} onCreated={() => {}} />
  ));

  expect(screen.getByText('Contact name').tagName).toBe('LABEL');
  expect(screen.getByLabelText('Contact name')).toBe(
    screen.getByRole('textbox', { name: 'Contact name' })
  );
  expect(screen.getByText('Email').closest('label')).not.toBeNull();
  expect(screen.getByLabelText('Email')).toHaveProperty('type', 'email');
  expect(screen.getByText('Company').tagName).toBe('LABEL');
  expect(screen.getByLabelText('Company')).toBe(
    screen.getByRole('button', { name: 'Choose a company' })
  );
});

it('names each field of a new company with a visible label', () => {
  render(() => (
    <CreateCompanyModal open onClose={() => {}} onCreated={() => {}} />
  ));

  expect(screen.getByText('Company name').tagName).toBe('LABEL');
  expect(screen.getByLabelText('Company name')).toBe(
    screen.getByRole('textbox', { name: 'Company name' })
  );
  expect(screen.getByText('Domain').closest('label')).not.toBeNull();
  expect(screen.getByLabelText('Domain')).toBe(
    screen.getByRole('textbox', { name: 'Domain' })
  );
});

it('names the field of a new pipeline with a visible label', () => {
  render(() => <PipelineDialog onCreate={async () => {}} onClose={() => {}} />);

  expect(screen.getByText('Pipeline name').tagName).toBe('LABEL');
  expect(screen.getByLabelText('Pipeline name')).toBe(
    screen.getByRole('textbox', { name: 'Pipeline name' })
  );
});
