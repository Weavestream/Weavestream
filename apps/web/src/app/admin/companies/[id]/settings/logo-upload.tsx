'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../lib/api';
import { uploadFile } from '../../../../../lib/upload-client';
import { Btn, CompanyAvatar, Icon, useToast } from '../../../../../components/ui';
import { companyAccent } from '../../../../../lib/company-format';
import type { CompanyDetail } from '../../../../../lib/server-api';

/**
 * Logo uploader built on top of the same-origin upload flow:
 *
 *   POST /companies/:id/uploads/init    → relay PUT url
 *   PUT <relay-url> with file body      → API streams to internal MinIO
 *   POST /companies/:id/uploads/confirm → creates the Upload row
 *   PATCH /companies/:id { logoUploadId } → points Company at the upload
 *
 * We skip the dropzone polish (progress bars, drag highlights, etc.)
 * in favour of a compact "pick file + preview + clear" trio that fits
 * inside the Settings Identity section.
 */
export function LogoUploadField({ company }: { company: CompanyDetail }) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile(file: File) {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Only image files are supported.');
      return;
    }
    // 5 MB — well below the server-side allowlist's MAX_UPLOAD_MB and
    // more than enough for a logo at a couple of display sizes.
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo files must be 5 MB or smaller.');
      return;
    }
    setBusy(true);
    try {
      // Reuse the shared client so the relay PUT, CSRF, and confirm
      // flow stay in lock-step with the article-editor uploader.
      const upload = await uploadFile({ companyId: company.id, file });

      const patch = await apiFetch(`/companies/${company.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ logoUploadId: upload.id }),
      });
      if (!patch.ok) throw new Error('patch-failed');

      toast.push('Logo updated.', 'ok');
      router.refresh();
    } catch (err) {
      const problem = (err as { message?: string } | undefined)?.message ?? 'upload-failed';
      setError(`Upload failed (${problem}). Try again.`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function clearLogo() {
    setBusy(true);
    const res = await apiFetch(`/companies/${company.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ logoUploadId: null }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.push('Could not remove the logo.', 'danger');
      return;
    }
    toast.push('Logo removed.', 'ok');
    router.refresh();
  }

  const previewUrl = company.logo?.thumbnailUrl ?? company.logo?.url ?? null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <CompanyAvatar
        name={company.name}
        color={companyAccent(company.id)}
        size={56}
        logoUrl={previewUrl}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn
            kind="outline"
            size="sm"
            icon={Icon.image}
            onClick={() => inputRef.current?.click()}
            loading={busy}
            type="button"
          >
            {company.logo ? 'Replace' : 'Upload logo'}
          </Btn>
          {company.logo && (
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.trash}
              onClick={clearLogo}
              disabled={busy}
              type="button"
            >
              Remove
            </Btn>
          )}
        </div>
        <span
          style={{
            fontSize: 11.5,
            color: error ? 'var(--danger)' : 'var(--muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error ?? 'PNG, JPG, WebP, or SVG · up to 5 MB'}
        </span>
      </div>
    </div>
  );
}
