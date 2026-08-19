/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MenuDivider, MenuItem, OverflowMenu } from './overflow-menu';

function Fixture() {
  return (
    <OverflowMenu>
      {(close) => (
        <>
          <MenuItem icon={undefined} onClick={close}>
            First
          </MenuItem>
          <MenuItem onClick={close}>Second</MenuItem>
          <MenuDivider />
          <MenuItem onClick={close} disabled>
            Unavailable
          </MenuItem>
          <MenuItem href="/somewhere" onClick={close}>
            Last
          </MenuItem>
        </>
      )}
    </OverflowMenu>
  );
}

const trigger = () => screen.getByRole('button', { name: 'More actions' });
const menu = () => screen.getByRole('menu');

describe('OverflowMenu', () => {
  it('moves focus into the menu on open and back to the trigger on Escape', () => {
    render(<Fixture />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger());
    // Opening a menu puts you in it — otherwise the first arrow press
    // does nothing at all.
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('opens from the trigger with ArrowDown', () => {
    render(<Fixture />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
  });

  it('rolls focus with the arrow keys, skipping disabled rows and wrapping', () => {
    render(<Fixture />);
    fireEvent.click(trigger());

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus();

    // "Unavailable" is disabled, so the next row down is the link.
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();
  });

  it('jumps to the ends with Home and End', () => {
    render(<Fixture />);
    fireEvent.click(trigger());

    fireEvent.keyDown(menu(), { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();

    fireEvent.keyDown(menu(), { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
  });

  it('dismisses on Tab and returns focus so tabbing continues from the trigger', () => {
    render(<Fixture />);
    fireEvent.click(trigger());
    fireEvent.keyDown(menu(), { key: 'Tab' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('keeps its rows out of the tab order', () => {
    render(<Fixture />);
    fireEvent.click(trigger());
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('tabindex', '-1');
    }
  });

  it('flags hidden work with an accessible marker only when asked', () => {
    const { rerender } = render(
      <OverflowMenu>{() => <MenuItem>Only</MenuItem>}</OverflowMenu>,
    );
    expect(
      screen.queryByRole('img', { name: 'needs attention' }),
    ).not.toBeInTheDocument();

    rerender(
      <OverflowMenu attention="warn">{() => <MenuItem>Only</MenuItem>}</OverflowMenu>,
    );
    expect(screen.getByRole('img', { name: 'needs attention' })).toBeInTheDocument();
  });
});
