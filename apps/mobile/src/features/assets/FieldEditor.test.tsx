/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReadonlyField, ScalarFieldEditor } from './FieldEditor';
import { makeLayoutField } from './test-fixtures';
import type { FieldEditorValue } from './field-values';

function renderScalar(
  fieldOver: Parameters<typeof makeLayoutField>[0],
  value: FieldEditorValue,
) {
  const onChange = jest.fn();
  render(
    <ScalarFieldEditor
      field={makeLayoutField(fieldOver)}
      id="t"
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('scalar input attributes', () => {
  it('EMAIL uses type=email with assist suppression', () => {
    renderScalar({ slug: 'e', fieldType: 'EMAIL' }, { kind: 'text', text: '' });
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('autocapitalize', 'none');
  });

  it('PHONE uses type=tel', () => {
    renderScalar({ slug: 'p', fieldType: 'PHONE' }, { kind: 'text', text: '' });
    expect(screen.getByRole('textbox')).toHaveAttribute('type', 'tel');
  });

  it('IP_ADDRESS is plain text (never a numeric pad) with a version-aware placeholder', () => {
    renderScalar(
      { slug: 'ip', fieldType: 'IP_ADDRESS', options: { version: 'v4', allowCidr: true } },
      { kind: 'text', text: '' },
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).not.toHaveAttribute('inputmode');
    expect(input).toHaveAttribute('placeholder', '10.0.0.0/24');
  });

  it('NUMBER uses type=number with decimal input mode', () => {
    renderScalar({ slug: 'n', fieldType: 'NUMBER' }, { kind: 'text', text: '42' });
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveAttribute('step', 'any');
  });

  it('DATE and DATETIME use the native pickers', () => {
    renderScalar({ slug: 'd', fieldType: 'DATE' }, { kind: 'text', text: '2026-03-14' });
    expect(document.querySelector('input[type="date"]')).not.toBeNull();
    renderScalar(
      { slug: 'dt', fieldType: 'DATETIME' },
      { kind: 'text', text: '2026-03-14T10:00' },
    );
    expect(document.querySelector('input[type="datetime-local"]')).not.toBeNull();
  });

  it('TEXTAREA renders a textarea and preserves raw text', () => {
    const onChange = renderScalar(
      { slug: 'ta', fieldType: 'TEXTAREA' },
      { kind: 'text', text: '' },
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' raw ' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'text', text: ' raw ' });
  });
});

describe('BOOLEAN switch', () => {
  it('renders role=switch with aria-checked and toggles', () => {
    const onChange = renderScalar(
      { slug: 'b', fieldType: 'BOOLEAN' },
      { kind: 'boolean', on: false },
    );
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ kind: 'boolean', on: true });
  });
});

describe('DropdownSelect', () => {
  const options = {
    choices: [
      { slug: 'prod', label: 'Production' },
      { slug: 'dr', label: 'Disaster recovery' },
    ],
    allowOther: true,
  };

  it('renders choices, an empty option, and Other…; selecting emits the slug', () => {
    const onChange = renderScalar(
      { slug: 'env', fieldType: 'DROPDOWN', options },
      { kind: 'dropdown', other: false, choice: '', otherText: '' },
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'dr' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'dropdown',
      other: false,
      choice: 'dr',
      otherText: '',
    });
  });

  it('selecting Other… swaps to a free-text input with a way back', () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <ScalarFieldEditor
        field={makeLayoutField({ slug: 'env', fieldType: 'DROPDOWN', options })}
        id="t"
        value={{ kind: 'dropdown', other: false, choice: '', otherText: '' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__other__' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'dropdown',
      other: true,
      choice: '',
      otherText: '',
    });

    rerender(
      <ScalarFieldEditor
        field={makeLayoutField({ slug: 'env', fieldType: 'DROPDOWN', options })}
        id="t"
        value={{ kind: 'dropdown', other: true, choice: '', otherText: 'custom' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('custom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose from list instead' }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'dropdown',
      other: false,
      choice: '',
      otherText: '',
    });
  });

  it('injects an out-of-catalog seeded value as a selectable option', () => {
    renderScalar(
      { slug: 'env', fieldType: 'DROPDOWN', options: { choices: options.choices } },
      { kind: 'dropdown', other: false, choice: 'legacy', otherText: '' },
    );
    expect(screen.getByRole('option', { name: 'legacy (not in list)' })).toBeInTheDocument();
  });
});

describe('MultiselectChips', () => {
  const options = {
    choices: [
      { slug: 'dns', label: 'DNS' },
      { slug: 'dhcp', label: 'DHCP' },
      { slug: 'ntp', label: 'NTP' },
    ],
    maxSelections: 2,
  };

  it('toggles chips and enforces maxSelections with an n/max hint', () => {
    const onChange = renderScalar(
      { slug: 'roles', fieldType: 'MULTISELECT', options },
      { kind: 'multiselect', slugs: ['dns', 'dhcp'] },
    );
    expect(screen.getByText('2/2 selected')).toBeInTheDocument();
    // At max: the unselected chip is disabled…
    expect(screen.getByRole('button', { name: 'NTP' })).toBeDisabled();
    // …while a selected one can still be toggled off.
    fireEvent.click(screen.getByRole('button', { name: 'DHCP' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'multiselect', slugs: ['dns'] });
  });

  it('renders stored-but-unknown slugs as removable chips', () => {
    const onChange = renderScalar(
      { slug: 'roles', fieldType: 'MULTISELECT', options: { choices: options.choices } },
      { kind: 'multiselect', slugs: ['legacy_role'] },
    );
    fireEvent.click(screen.getByRole('button', { name: 'legacy_role' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'multiselect', slugs: [] });
  });
});

describe('ReadonlyField', () => {
  it('wraps the display with the edit-on-desktop note', () => {
    render(
      <ReadonlyField>
        <span>rendered value</span>
      </ReadonlyField>,
    );
    expect(screen.getByText('rendered value')).toBeInTheDocument();
    expect(
      screen.getByText('View only on mobile — edit this field on desktop.'),
    ).toBeInTheDocument();
  });
});
