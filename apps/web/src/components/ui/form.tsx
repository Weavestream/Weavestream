import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

const controlBase: CSSProperties = {
  height: 32,
  padding: '0 10px',
  background: 'var(--panel-2)',
  border: '1px solid var(--line-2)',
  borderRadius: 5,
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  outline: 'none',
  width: '100%',
};

const labelBase: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  marginBottom: 6,
};

const plainLabel: CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  fontFamily: 'var(--font-sans)',
  color: 'var(--text-2)',
  fontWeight: 600,
  marginBottom: 6,
};

const errorStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11.5,
  color: 'var(--danger)',
};

const helpStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11.5,
  color: 'var(--muted)',
};

export function Field({
  label,
  labelVariant = 'caps',
  htmlFor,
  error,
  help,
  children,
  style,
}: {
  label?: string;
  labelVariant?: 'caps' | 'plain';
  htmlFor?: string;
  error?: string;
  help?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...style }}>
      {label && (
        <label
          htmlFor={htmlFor}
          style={labelVariant === 'plain' ? plainLabel : labelBase}
        >
          {label}
        </label>
      )}
      {children}
      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : help ? (
        <div style={helpStyle}>{help}</div>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ style, ...rest }, ref) {
    return <input ref={ref} {...rest} style={{ ...controlBase, ...style }} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ style, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      {...rest}
      style={{
        ...controlBase,
        height: 'auto',
        padding: 10,
        minHeight: 80,
        ...style,
      }}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ style, children, ...rest }, ref) {
    return (
      <select ref={ref} {...rest} style={{ ...controlBase, ...style }}>
        {children}
      </select>
    );
  },
);
