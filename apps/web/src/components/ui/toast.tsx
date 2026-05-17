'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type Tone = 'default' | 'ok' | 'warn' | 'danger' | 'info';

type Toast = { id: number; message: string; tone: Tone };

type Ctx = { push: (message: string, tone?: Tone) => void };

const ToastCtx = createContext<Ctx | null>(null);

let _id = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Tone = 'default') => {
    const id = ++_id;
    setToasts((s) => [...s, { id, message, tone }]);
    setTimeout(() => setToasts((s) => s.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          // Above Sheet (80) and Dialog (90) so success/error feedback
          // remains visible regardless of what modal is on screen.
          zIndex: 100,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

function ToastItem({ toast }: { toast: Toast }) {
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setEnter(true), 20);
    return () => clearTimeout(id);
  }, []);
  const toneColor =
    toast.tone === 'ok'
      ? 'var(--ok)'
      : toast.tone === 'warn'
        ? 'var(--warn)'
        : toast.tone === 'danger'
          ? 'var(--danger)'
          : toast.tone === 'info'
            ? 'var(--info)'
            : 'var(--text-2)';
  return (
    <div
      style={{
        minWidth: 260,
        maxWidth: 360,
        background: 'var(--panel)',
        border: `1px solid var(--line-2)`,
        borderLeft: `2px solid ${toneColor}`,
        borderRadius: 5,
        padding: '10px 12px',
        fontSize: 12.5,
        color: 'var(--text)',
        boxShadow: 'var(--shadow-2)',
        pointerEvents: 'auto',
        transform: enter ? 'translateY(0)' : 'translateY(8px)',
        opacity: enter ? 1 : 0,
        transition: 'transform 180ms ease, opacity 180ms ease',
      }}
    >
      {toast.message}
    </div>
  );
}
