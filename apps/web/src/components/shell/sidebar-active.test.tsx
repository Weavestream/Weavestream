/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import {
  SidebarActive,
  SidebarActiveProvider,
  useSidebarActiveOverride,
} from './sidebar-active';

function Probe() {
  return <output>{useSidebarActiveOverride() ?? 'none'}</output>;
}

describe('SidebarActive', () => {
  it('sets the override while mounted and clears it on unmount', () => {
    const { rerender } = render(
      <SidebarActiveProvider>
        <Probe />
        <SidebarActive id="layout:abc" />
      </SidebarActiveProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('layout:abc');

    rerender(
      <SidebarActiveProvider>
        <Probe />
      </SidebarActiveProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('none');
  });

  it('keeps the newest override when an older setter cleans up', () => {
    const { rerender } = render(
      <SidebarActiveProvider>
        <Probe />
        <SidebarActive id="layout:old" />
        <SidebarActive id="layout:new" />
      </SidebarActiveProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('layout:new');

    rerender(
      <SidebarActiveProvider>
        <Probe />
        <SidebarActive id="layout:new" />
      </SidebarActiveProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('layout:new');
  });

  it('is a safe no-op without a provider', () => {
    render(
      <>
        <SidebarActive id="layout:abc" />
        <Probe />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('none');
  });
});
