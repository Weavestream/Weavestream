import type {
  PasswordAccessUser as SharedPasswordAccessUser,
  PasswordDetail,
  PasswordFolderSchema,
  PasswordSummary,
  PasswordVersionSummary,
} from '@weavestream/shared';
import type { SameShape, WireJson } from '../common/wire-contract.js';
import type {
  PasswordAccessUser,
  SerializedPasswordDetail,
  SerializedPasswordFolder,
  SerializedPasswordSummary,
  SerializedPasswordVersion,
} from './passwords.service.js';

// Type-level contracts: the JSON form of each password serializer type must
// be exactly the shared contract that the web and mobile clients read. If
// either side changes alone, a `true` literal below stops type-checking.
describe('password wire contracts', () => {
  it('serializes SerializedPasswordSummary to the shared PasswordSummary', () => {
    const same: SameShape<WireJson<SerializedPasswordSummary>, PasswordSummary> = true;
    expect(same).toBe(true);
  });

  it('serializes SerializedPasswordDetail to the shared PasswordDetail', () => {
    const same: SameShape<WireJson<SerializedPasswordDetail>, PasswordDetail> = true;
    expect(same).toBe(true);
  });

  it('serializes SerializedPasswordVersion to the shared PasswordVersionSummary', () => {
    const same: SameShape<WireJson<SerializedPasswordVersion>, PasswordVersionSummary> = true;
    expect(same).toBe(true);
  });

  it('serializes SerializedPasswordFolder to the shared PasswordFolderSchema', () => {
    const same: SameShape<WireJson<SerializedPasswordFolder>, PasswordFolderSchema> = true;
    expect(same).toBe(true);
  });

  it('serializes PasswordAccessUser to the shared PasswordAccessUser', () => {
    const same: SameShape<WireJson<PasswordAccessUser>, SharedPasswordAccessUser> = true;
    expect(same).toBe(true);
  });
});
