'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Btn, Icon } from '../../../../../components/ui';

export function NewPasswordAction() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function open() {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('new', '1');
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <Btn kind="primary" size="md" icon={Icon.plus} onClick={open}>
      New password
    </Btn>
  );
}
