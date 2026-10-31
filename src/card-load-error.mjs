/** Small public diagnostics. Never expose raw exception text, paths or URLs. */
export function cardLoadError({ response, error, kind, stage = 'image' } = {}) {
  const code = error?.cause?.code ?? error?.code;
  const status = response?.status;
  const retry = response?.headers.get('retry-after');
  const retryAt = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
  return {
    kind: kind ?? (status === 429 ? 'rate_limited' : status === 404 ? 'not_found' :
      status && status >= 400 ? 'http' : error?.name === 'TimeoutError' || /TIMEOUT/.test(code ?? '') ? 'timeout' :
      error ? 'connection' : 'unavailable'),
    stage,
    ...(status ? { status } : {}),
    ...(['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? { code } : {}),
    retry_locked: status === 429 || Number.isFinite(retryAt) && retryAt > Date.now(),
  };
}
