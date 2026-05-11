import type { CSSProperties, SVGProps } from 'react';

export type IconProps = {
  size?: number;
  stroke?: number;
  style?: CSSProperties;
  className?: string;
};

type SvgChildren = SVGProps<SVGSVGElement>['children'];

export function IconBase({
  size = 14,
  stroke = 1.5,
  style,
  className,
  children,
}: IconProps & { children: SvgChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  home: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 7l6-5 6 5v6a1 1 0 0 1-1 1H9v-4H7v4H3a1 1 0 0 1-1-1V7z" />
    </IconBase>
  ),
  building: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2.5" y="2" width="11" height="12" rx="0.5" />
      <path d="M5 5h1M5 8h1M5 11h1M10 5h1M10 8h1M10 11h1" />
    </IconBase>
  ),
  box: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 5l6-3 6 3v6l-6 3-6-3V5z" />
      <path d="M2 5l6 3 6-3M8 8v6" />
    </IconBase>
  ),
  doc: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 2h5l3 3v9H4V2z" />
      <path d="M9 2v3h3" />
    </IconBase>
  ),
  folder: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" />
    </IconBase>
  ),
  search: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5L10.5 10.5" />
    </IconBase>
  ),
  filter: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 3h12l-4.5 6v4l-3 1V9L2 3z" />
    </IconBase>
  ),
  plus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 3v10M3 8h10" />
    </IconBase>
  ),
  chevron: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5.5 3l4 5-4 5" />
    </IconBase>
  ),
  chevronD: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 5.5l5 4 5-4" />
    </IconBase>
  ),
  caret: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 6l4 4 4-4" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  link: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M7 10.5L5 12.5a2.5 2.5 0 0 1-3.5-3.5l2-2M9 5.5l2-2a2.5 2.5 0 0 1 3.5 3.5l-2 2M6 10L10 6" />
    </IconBase>
  ),
  ext: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 3h4v4M13 3L8 8M6 4H3v9h9v-3" />
    </IconBase>
  ),
  bell: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 7a4 4 0 0 1 8 0v3l1 2H3l1-2V7z" />
      <path d="M7 13a1 1 0 0 0 2 0" />
    </IconBase>
  ),
  gear: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </IconBase>
  ),
  grid: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </IconBase>
  ),
  list: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </IconBase>
  ),
  menu: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </IconBase>
  ),
  users: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <path d="M2 13a4 4 0 0 1 8 0M11 4a2 2 0 0 1 0 4M10 13a4 4 0 0 1 4-2" />
    </IconBase>
  ),
  shield: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 1.5L3 3v5c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V3l-5-1.5z" />
    </IconBase>
  ),
  globe: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </IconBase>
  ),
  key: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="5" cy="11" r="2.5" />
      <path d="M7 9l6-6M11 5l2 2" />
    </IconBase>
  ),
  lock: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </IconBase>
  ),
  lockOpen: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0" />
    </IconBase>
  ),
  eye: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
    </IconBase>
  ),
  eyeOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 3l10 10M1 8s2.5-4.5 7-4.5c1.4 0 2.6.4 3.6 1M15 8s-2.5 4.5-7 4.5c-1.4 0-2.6-.4-3.6-1" />
    </IconBase>
  ),
  tag: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 2h5l7 7-5 5-7-7V2z" />
      <circle cx="5" cy="5" r="0.5" fill="currentColor" />
    </IconBase>
  ),
  zap: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 1L2 9h5l-1 6 7-8H8l1-6z" />
    </IconBase>
  ),
  clock: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4v4l2.5 1.5" />
    </IconBase>
  ),
  copy: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="5" y="5" width="9" height="9" rx="1" />
      <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
    </IconBase>
  ),
  edit: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
    </IconBase>
  ),
  archive: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 4h12v2H2zM3 6h10v8H3zM6 9h4" />
    </IconBase>
  ),
  trash: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l1 10h6l1-10" />
    </IconBase>
  ),
  star: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 1.5l2 4.5 5 .5-3.5 3.5 1 5-4.5-2.5-4.5 2.5 1-5L1 6.5l5-.5 2-4.5z" />
    </IconBase>
  ),
  dots: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  dotsV: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="3" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="13" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  grip: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="5" cy="3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="5" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="5" cy="13" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="13" r="0.8" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  check: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 8l3 3 7-7" />
    </IconBase>
  ),
  checkSquare: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M5 8l2 2 4-4" />
    </IconBase>
  ),
  x: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </IconBase>
  ),
  warn: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 1.5L14.5 13H1.5L8 1.5z" />
      <path d="M8 6v3M8 11v0.5" />
    </IconBase>
  ),
  server: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2" y="3" width="12" height="4" rx="0.5" />
      <rect x="2" y="9" width="12" height="4" rx="0.5" />
      <circle cx="4.5" cy="5" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="11" r="0.4" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  laptop: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="3" width="10" height="7" rx="0.5" />
      <path d="M1 12h14" />
    </IconBase>
  ),
  person: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </IconBase>
  ),
  network: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="3" r="1.5" />
      <circle cx="3" cy="12" r="1.5" />
      <circle cx="13" cy="12" r="1.5" />
      <path d="M8 4.5v6M8 10.5l-4 1M8 10.5l4 1" />
    </IconBase>
  ),
  logout: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M10 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6" />
      <path d="M12 11l3-3-3-3M15 8H7" />
    </IconBase>
  ),
  sun: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </IconBase>
  ),
  moon: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M13 9.5A6 6 0 0 1 6.5 3a6 6 0 1 0 6.5 6.5z" />
    </IconBase>
  ),
  image: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2" y="3" width="12" height="10" rx="0.5" />
      <circle cx="6" cy="7" r="1" />
      <path d="M2 11l3-3 3 3 2-2 4 4" />
    </IconBase>
  ),
  sparkles: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
      <path d="M11 8l0.6 1.8 1.8 0.6-1.8 0.6L11 12.8l-0.6-1.8-1.8-0.6 1.8-0.6L11 8z" />
    </IconBase>
  ),
  refresh: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2v3.5H10" />
    </IconBase>
  ),
  plug: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5 1v3M11 1v3" />
      <path d="M3 4h10v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V4z" />
      <path d="M8 11v4" />
    </IconBase>
  ),
  sync: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13 5" />
      <path d="M13 2v3h-3" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L3 11" />
      <path d="M3 14v-3h3" />
    </IconBase>
  ),
  chat: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11h-0.5a1 1 0 0 1-1-1V4z" />
    </IconBase>
  ),
  chatFilled: (p: IconProps) => (
    <IconBase {...p}>
      <path
        d="M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11h-0.5a1 1 0 0 1-1-1V4z"
        fill="currentColor"
      />
    </IconBase>
  ),
  panelRight: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M10 3v10" />
    </IconBase>
  ),
};

export type IconName = keyof typeof Icon;
export type IconComponent = (p: IconProps) => React.ReactElement;
