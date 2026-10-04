// Stage A only: fixed reader + collection/inventory; no account/debug APIs.
let reader;
import { createHash } from 'node:crypto';
const integer = value => Number.isSafeInteger(value) && value >= 0;
function stop(code) { const e = new Error(code); e.safeCode = code; throw e; }
function checkError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stop('READER_SHAPE');
  if (Object.hasOwn(value, 'error')) {
    const e = typeof value.error === 'string' ? value.error : '';
    stop(/task_for_pid|permission|KERN_FAILURE/i.test(e) ? 'READ_PERMISSION_REQUIRED'
      : /home screen|root singleton/i.test(e) ? 'ARENA_HOME_REQUIRED'
      : /not found|dead process/i.test(e) ? 'ARENA_NOT_RUNNING' : 'READER_FAILED');
  }
}
async function once() {
  const c = await reader.readCollection('MTGA'); checkError(c);
  const i = await reader.readInventory('MTGA'); checkError(i);
  if (!integer(c.count) || !Array.isArray(c.cards) || c.count !== c.cards.length || !c.cards.length) stop('COLLECTION_INCOMPLETE');
  const seen = new Set();
  const cards = c.cards.map(card => {
    if (!card || !Number.isSafeInteger(card.grpId) || card.grpId <= 0 || !integer(card.qty) || seen.has(card.grpId)) stop('COLLECTION_INVALID');
    seen.add(card.grpId); return { grpId: card.grpId, qty: card.qty };
  }).sort((a,b) => a.grpId-b.grpId);
  if (!cards.some(card => card.qty > 0)) stop('COLLECTION_EMPTY');
  const inventory = { gold:i.gold, gems:i.gems, wildcards: { common:i.wildcards?.common, uncommon:i.wildcards?.uncommon, rare:i.wildcards?.rare, mythic:i.wildcards?.mythic } };
  if (![inventory.gold,inventory.gems,...Object.values(inventory.wildcards)].every(integer)) stop('INVENTORY_UNKNOWN');
  const content_hash = createHash('sha256').update(JSON.stringify({cards,inventory})).digest('hex');
  return { cards, inventory, content_hash };
}
try {
  reader = (await import('mtga-reader')).default;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') stop('HELPER_ARCHITECTURE');
  const first = await once(), second = await once();
  if (first.content_hash !== second.content_hash) stop('READ_UNSTABLE');
  console.log(JSON.stringify({ schema:'MTGA_COLLECTION_PROBE_V1', read_at:new Date().toISOString(), source:'mtga-reader@0.1.13/readCollection+readInventory', stable_reads:2, ...second }));
} catch (e) {
  console.log(JSON.stringify({ok:false,code:e.safeCode ?? 'READER_FAILED'})); process.exitCode=1;
} finally { try { reader?.close(); } catch {} }
