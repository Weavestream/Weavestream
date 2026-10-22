import { Tag } from '../../components/ui';

/**
 * The mark for an AI app that registered itself: Weavestream cannot check its
 * name or identity. Shared by the consent page and the connection lists.
 */
export function NotVerifiedTag() {
  return (
    <Tag tone="warn" mono={false}>
      Not verified
    </Tag>
  );
}
