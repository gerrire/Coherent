import { expect, it } from 'vitest';
import { publicCryptoError } from '../src/lib/crypto/errors';
import { readOnlyCommand } from '../src/lib/crypto/types';

it('identifies only the known legacy invitation defect for session repair', () => {
  expect(publicCryptoError(new Error('MLS_WELCOME_TREE_MISSING')).code).toBe('WELCOME_TREE_MISSING');
  expect(publicCryptoError(new Error('The authenticated encrypted object could not be opened')).code).toBe('INTEGRITY');
  expect(publicCryptoError(new Error('The device identity is not pinned for this conversation')).code).toBe('UNTRUSTED_DEVICE');
});

it('never exposes unexpected error contents or secret material', () => {
  const secret = 'private-snapshot-or-recovery-words';
  expect(JSON.stringify(publicCryptoError(new Error(secret)))).not.toContain(secret);
  expect(publicCryptoError(new DOMException('opaque-browser-detail', 'QuotaExceededError')).code).toBe('STORAGE_FULL');
  expect(publicCryptoError(new DOMException('opaque-browser-detail', 'DataCloneError')).code).toBe('STORAGE_UNAVAILABLE');
});

it('does not skip durable writes for key, trust, ratchet or archive changes', () => {
  expect(readOnlyCommand({ operation: 'identity' })).toBe(true);
  expect(readOnlyCommand({ operation: 'group_status', conversation_id: 'room' })).toBe(true);
  expect(readOnlyCommand({ operation: 'key_package' })).toBe(false);
  expect(readOnlyCommand({ operation: 'accept_roster', public_key: '', roster: { payload: '', signature: '' }, fingerprint: null })).toBe(false);
  expect(readOnlyCommand({ operation: 'open_backup', context: { conversation_id: '', message_id: '', sender_account_id: '', sender_device_id: '' }, body: { version: 1, nonce: '', ciphertext: '' }, backup: { version: 1, recipient: '', encapsulated: '', ciphertext: '' } })).toBe(false);
});
