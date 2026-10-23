import { createHash } from 'node:crypto';
export const validAccountKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function arenaAccountKey(id) {
  return typeof id === 'string' && /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z0-9]{26})$/i.test(id) ?
    createHash('sha256').update('MTGA_ACCOUNT_V1\0' + id.toLowerCase()).digest('hex') : null;
}
export function filterAccount(items, account) {
  if (account == null) return items;
  return items.filter(item => account === 'unassigned' ? !validAccountKey(item.account_key) : item.account_key === account);
}
