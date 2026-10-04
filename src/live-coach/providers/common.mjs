import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProviderBlockedError extends Error {
  constructor(code, message) { super(message); this.name = 'ProviderBlockedError'; this.code = code; }
}

export function privateJsonRead(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077)) {
      throw new ProviderBlockedError('insecure_credentials', 'Private runtime file must be a regular owner-only file.');
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof ProviderBlockedError) throw error;
    throw new ProviderBlockedError('invalid_private_file', 'Private runtime file is unreadable or malformed; credentials were not logged.');
  }
}

export function privateJsonWrite(filePath, value) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new ProviderBlockedError('insecure_credentials', 'Private runtime directory must not be a symlink.');
  chmodSync(dir, 0o700);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}

export function operationSignal(signal, timeoutMs = 15000) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Provider deadline exceeded.', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, abort: reason => controller.abort(reason), dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

export async function checkedJson(response, label) {
  if (!response.ok) {
    // Do not print remote payloads: they can echo keys, prompts or private context.
    await response.body?.cancel().catch(() => {});
    throw new ProviderBlockedError(`${label}_http_${response.status}`, `${label} request failed (HTTP ${response.status}); no fallback was attempted.`);
  }
  try { return await response.json(); }
  catch { throw new ProviderBlockedError('invalid_provider_json', `${label} returned malformed JSON; payload was not logged.`); }
}

function parseEvent(payload) {
  try { return JSON.parse(payload); }
  catch { throw new ProviderBlockedError('invalid_provider_json', 'Provider stream contained malformed JSON; payload was discarded.'); }
}

export async function* sseJson(body, { signal, maxEventBytes = 2 * 1024 * 1024 } = {}) {
  if (!body) throw new ProviderBlockedError('missing_stream', 'Provider returned no stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let eventSize = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > maxEventBytes) throw new ProviderBlockedError('stream_too_large', 'Provider event exceeded the local size limit.');
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n');
            data = []; eventSize = 0;
            if (payload !== '[DONE]') yield parseEvent(payload);
          }
        } else if (line.startsWith('data:')) {
          const payload = line.slice(5).replace(/^ /, '');
          eventSize += payload.length;
          if (eventSize > maxEventBytes) throw new ProviderBlockedError('stream_too_large', 'Provider event exceeded the local size limit.');
          data.push(payload);
        }
      }
      if (done) {
        // Accept a final SSE record without the optional terminating blank line.
        if (pending.startsWith('data:')) data.push(pending.slice(5).replace(/^ /, ''));
        if (data.length && data.join('\n') !== '[DONE]') yield parseEvent(data.join('\n'));
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function assertText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw new ProviderBlockedError('invalid_text', 'Speech requires non-empty text of at most 10,000 UTF-16 units.');
  return text;
}
