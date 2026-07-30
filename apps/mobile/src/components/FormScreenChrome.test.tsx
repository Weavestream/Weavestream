/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { FormScreenChrome } from './FormScreenChrome';

/**
 * The Save button has three shapes and the difference is not cosmetic.
 *
 * `submitFor` (Phase 5c) makes Save the associated form's **default
 * button**, which is the only way Enter/Go reaches a form whose fields block
 * implicit submission. Every other caller passes `onSave` and must keep
 * `type="button"` — a stray `type="submit"` inside some future form ancestor
 * would submit it.
 */
describe('FormScreenChrome — Save button shapes', () => {
  it('stays a plain button for `onSave` callers', () => {
    const onSave = jest.fn();
    render(
      <FormScreenChrome title="Edit" onCancel={() => {}} onSave={onSave} saveDisabled={false}>
        <p>body</p>
      </FormScreenChrome>,
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('type', 'button');
    expect(save).not.toHaveAttribute('form');
  });

  it('becomes a real submit button associated with the named form', () => {
    render(
      <FormScreenChrome title="Edit" onCancel={() => {}} submitFor="my-form" saveDisabled={false}>
        <form id="my-form" />
      </FormScreenChrome>,
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('type', 'submit');
    expect(save).toHaveAttribute('form', 'my-form');
  });

  it('is disabled the same way in the submit shape', () => {
    // Load-bearing beyond the click: the implicit-submission algorithm skips
    // a disabled default button, so this is also what gates the keyboard.
    render(
      <FormScreenChrome title="Edit" onCancel={() => {}} submitFor="my-form" saveDisabled>
        <form id="my-form" />
      </FormScreenChrome>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders an inert placeholder when there is no save action at all', () => {
    // The layout-chooser case: keeps the title centred without offering a
    // button that does nothing.
    render(
      <FormScreenChrome title="Choose a layout" onCancel={() => {}}>
        <p>body</p>
      </FormScreenChrome>,
    );

    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
