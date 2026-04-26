export function vaultLinkUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  const url = (value as { url?: unknown }).url;
  return typeof url === 'string' ? url : '';
}

export function vaultLinkLabel(value: unknown): string {
  if (value && typeof value === 'object') {
    const label = (value as { label?: unknown }).label;
    if (typeof label === 'string' && label.trim()) return label;
  }

  return vaultLinkUrl(value);
}
