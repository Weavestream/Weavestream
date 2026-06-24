import type { CSSProperties, ReactNode } from 'react';
import { Btn, Icon } from '../ui';

export function PasswordFormSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={sectionTitle}>{title}</div>
        {subtitle ? <div style={sectionSubtitle}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PasswordFieldGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}

export function PasswordAdvancedDisclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          border: 0,
          background: 'transparent',
          color: 'var(--accent)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 12.5,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon.chevron
          size={10}
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        Advanced settings
      </button>
      {open ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            paddingTop: 12,
          }}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function PasswordSettingChoice<T extends string>({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div style={settingRow}>
      <div style={{ minWidth: 0, width: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {title}
        </div>
        {description ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {description}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          width: '100%',
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              style={{
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--line-2)'}`,
                background: selected
                  ? 'var(--accent-soft, rgba(37,99,235,0.12))'
                  : 'var(--panel-2)',
                color: selected ? 'var(--accent)' : 'var(--text-2)',
                height: 28,
                borderRadius: 5,
                padding: '0 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PasswordTotpCard({
  status,
  description,
  actions,
  children,
  tone = 'default',
}: {
  status: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <div
      style={{
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--line)'}`,
        borderRadius: 8,
        background: danger
          ? 'var(--danger-soft, rgba(220,38,38,0.08))'
          : 'var(--panel-2)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: danger ? 'var(--danger)' : 'var(--text)',
            }}
          >
            {status}
          </div>
          {description ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {description}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function PasswordGhostAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Btn type="button" size="sm" kind="outline" onClick={onClick}>
      {children}
    </Btn>
  );
}

const sectionTitle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 700,
  color: 'var(--text)',
};

const sectionSubtitle: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  marginTop: 2,
};

const settingRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
  border: '1px solid var(--line)',
  borderRadius: 7,
  padding: '9px 10px',
  background: 'var(--panel)',
  flexWrap: 'wrap',
};
