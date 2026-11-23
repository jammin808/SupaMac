import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactRowEmail } from './contact-row-email';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

// The row stands in for a list row: a native mousedown listener, as the drag
// sensor attaches, and a click handler that opens the record.
function mountInRow() {
  const press = vi.fn();
  const open = vi.fn();
  render(() => (
    <div
      data-testid="row"
      ref={(row) => row.addEventListener('mousedown', press)}
      onClick={open}
    >
      <span>Example person</span>
      <ContactRowEmail email="person@example.com" />
    </div>
  ));
  return { press, open, element: screen.getByTestId('row') };
}

it('keeps a press on the address from starting a row drag', () => {
  const row = mountInRow();

  fireEvent.mouseDown(screen.getByText('person@example.com'));
  expect(row.press).not.toHaveBeenCalled();

  fireEvent.mouseDown(screen.getByText('Example person'));
  expect(row.press).toHaveBeenCalledOnce();
});

it('does not open the row when a selection of the address is released on it', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address);
  window.getSelection()?.selectAllChildren(address);
  fireEvent.click(address);

  expect(row.open).not.toHaveBeenCalled();
});

// A drag that ends past the address sends its click to the row, the nearest
// element holding both the press and the release.
it('does not open the row when a selection of the address is released past it', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address);
  window.getSelection()?.selectAllChildren(address);
  fireEvent.click(row.element);

  expect(row.open).not.toHaveBeenCalled();
});

it('opens the row on a plain click of the address', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address);
  fireEvent.click(address);

  expect(row.open).toHaveBeenCalledOnce();
});

it('opens the row when the selection lies elsewhere', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');
  window.getSelection()?.selectAllChildren(screen.getByText('Example person'));

  fireEvent.mouseDown(address);
  fireEvent.click(address);

  expect(row.open).toHaveBeenCalledOnce();
});

it('holds only the click of the press that selected the address', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address);
  window.getSelection()?.selectAllChildren(address);
  fireEvent.click(address);
  expect(row.open).not.toHaveBeenCalled();

  fireEvent.click(row.element);
  expect(row.open).toHaveBeenCalledOnce();
});

it('lets the click of a later press through when the first press had none', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address);
  window.getSelection()?.selectAllChildren(address);
  fireEvent.pointerDown(screen.getByText('Example person'));
  fireEvent.click(row.element);

  expect(row.open).toHaveBeenCalledOnce();
});

it('does not hold the click of a secondary-button press', () => {
  const row = mountInRow();
  const address = screen.getByText('person@example.com');

  fireEvent.mouseDown(address, { button: 2 });
  window.getSelection()?.selectAllChildren(address);
  fireEvent.click(row.element);

  expect(row.open).toHaveBeenCalledOnce();
});
