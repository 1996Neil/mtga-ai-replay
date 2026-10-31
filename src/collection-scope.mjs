import { join, resolve } from 'node:path';
import { validAccountKey } from './account-scope.mjs';

export function collectionAccountKey(value) {
  if (value === undefined) return undefined; // Legacy snapshots retain their original, unassigned location.
  if (!validAccountKey(value)) throw Object.assign(new Error('请选择已识别的游戏账号。'), { name: 'CollectionError', code: 'COLLECTION_ACCOUNT_INVALID' });
  return value;
}
export function collectionPrefix(accountKey) {
  const key = collectionAccountKey(accountKey);
  return key ? `collection/accounts/${key}/latest/` : 'collection/latest/';
}
export function collectionReadmePath(accountKey) {
  const key = collectionAccountKey(accountKey);
  return key ? `collection/accounts/${key}/README.md` : 'collection/README.md';
}
export function collectionStoreRoot(dataDir, accountKey) {
  const key = collectionAccountKey(accountKey), base = join(resolve(dataDir), 'collection');
  return key ? join(base, 'accounts', key) : base;
}
export function collectionStatePath(accountKey) {
  const key = collectionAccountKey(accountKey);
  return key ? `collection-sync/accounts/${key}/state.json` : 'collection-sync/state.json';
}
