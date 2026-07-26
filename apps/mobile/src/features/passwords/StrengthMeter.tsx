import {
  PASSWORD_STRENGTH_LABELS,
  PASSWORD_STRENGTH_TONES,
  type PasswordStrengthTone,
} from '@weavestream/shared';

/**
 * Five-segment strength meter — desktop's semantics (5 bars, shared
 * labels/tones, `null` = unscored grey + em-dash) at the handoff's bar
 * geometry (26×5 px, radius 3). The tone strings are semantic; this is
 * the mobile mapping to Tailwind classes.
 */
const TONE_BG: Record<PasswordStrengthTone, string> = {
  danger: 'bg-danger',
  warn: 'bg-warn',
  ok: 'bg-ok',
};

export function StrengthMeter({ score }: { score: number | null }) {
  const s = score ?? -1;
  const tone = s >= 0 ? PASSWORD_STRENGTH_TONES[s] : undefined;

  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={
              'h-[5px] w-[26px] rounded-[3px] ' +
              (i <= s && tone ? TONE_BG[tone] : 'bg-line-3')
            }
          />
        ))}
      </div>
      <span className="text-[14px] font-medium text-muted">
        {score === null ? '—' : PASSWORD_STRENGTH_LABELS[s]}
      </span>
    </div>
  );
}
