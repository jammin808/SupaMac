import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it } from 'vitest';
import { RecordTitle } from './record-title';

afterEach(cleanup);

function mount() {
  const attempts: string[] = [];
  const rejections: Array<() => void> = [];
  const [record, setRecord] = createSignal({
    id: 'contact-1',
    name: 'Saved name',
  });
  render(() => (
    <RecordTitle
      recordId={record().id}
      value={record().name}
      placeholder="Contact"
      ariaLabel="Contact name"
      rename={(name, onError) => {
        attempts.push(name);
        rejections.push(onError);
      }}
    />
  ));
  const field = () =>
    screen.getByRole<HTMLInputElement>('textbox', { name: 'Contact name' });
  const typeAndCommit = (name: string) => {
    field().focus();
    fireEvent.input(field(), { target: { value: name } });
    fireEvent.keyDown(field(), { key: 'Enter' });
  };
  return { attempts, rejections, field, setRecord, typeAndCommit };
}

it('keeps a rejected name in the field and tries it again on Enter', () => {
  const title = mount();
  title.typeAndCommit('Typed name');
  expect(title.attempts).toEqual(['Typed name']);

  title.rejections[0]?.();
  expect(title.field().value).toBe('Typed name');

  title.field().focus();
  fireEvent.keyDown(title.field(), { key: 'Enter' });
  expect(title.attempts).toEqual(['Typed name', 'Typed name']);
});

it('drops a rejected name on Escape', () => {
  const title = mount();
  title.typeAndCommit('Typed name');
  title.rejections[0]?.();

  title.field().focus();
  fireEvent.keyDown(title.field(), { key: 'Escape' });

  expect(title.field().value).toBe('Saved name');
  expect(title.attempts).toEqual(['Typed name']);
});

it('leaves text typed after the rename alone', () => {
  const title = mount();
  title.typeAndCommit('Typed name');
  title.field().focus();
  fireEvent.input(title.field(), { target: { value: 'Another name' } });

  title.rejections[0]?.();

  expect(title.field().value).toBe('Another name');
});

it('does not carry a rejected name to another record', () => {
  const title = mount();
  title.typeAndCommit('Typed name');
  title.rejections[0]?.();
  expect(title.field().value).toBe('Typed name');

  title.setRecord({ id: 'contact-2', name: 'Other record' });
  expect(title.field().value).toBe('Other record');

  title.rejections[0]?.();
  expect(title.field().value).toBe('Other record');
});
