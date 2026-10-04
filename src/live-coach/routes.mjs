const json = (response, status, value) => { response.writeHead(status, {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
async function body(request, maxBytes = 4096) {
  let text = '';
  for await (const chunk of request) { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > maxBytes) throw new Error('body_limit'); }
  return text ? JSON.parse(text) : {};
}
export function createCoachRoutes(runtime) {
  const clients = new Set();
  const forward = event => { const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) { if (client.writableLength > 128 * 1024) { client.destroy(); clients.delete(client); } else client.write(message); } };
  runtime.controller.on('event', forward);
  return {
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/api/live-coach/')) return false;
      const path = url.pathname.slice('/api/live-coach/'.length);
      if (request.method === 'GET' && path === 'status') { json(response, 200, runtime.snapshot()); return true; }
      if (request.method === 'GET' && path === 'setup' && runtime.setup) { json(response, 200, runtime.setup.snapshot()); return true; }
      if (request.method === 'GET' && path === 'events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.write(`data: ${JSON.stringify({ type: 'status', ...runtime.snapshot() })}\n\n`);
        clients.add(response); request.on('close', () => clients.delete(response)); return true;
      }
      if (request.method === 'GET' && /^audio\/[a-f0-9-]{36}$/.test(path)) {
        const audio = runtime.controller.audio(path.slice(6));
        if (!audio) json(response, 410, { error: '建议已撤销或音频尚未就绪。' });
        else { response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': audio.length }); response.end(audio); }
        return true;
      }
      if (request.method !== 'POST') { json(response, 405, { error: 'Unsupported coach route.' }); return true; }
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-mtga-coach-action'] !== 'session') {
        json(response, 403, { error: 'Same-origin coach action required.' }); return true;
      }
      try {
        const input = await body(request, path === 'setup' ? 8192 : 4096);
        if (runtime.setup?.reconfiguring && ['start', 'unmute', 'observe'].includes(path)) throw new Error('setup_reconfiguring');
        switch (path) {
          case 'setup':
            if (!runtime.setup) throw new Error('setup_unavailable');
            json(response, 200, await runtime.setup.save(input)); return true;
          case 'setup/voices':
            if (!runtime.setup) throw new Error('setup_unavailable');
            json(response, 200, await runtime.setup.availableVoices(input.provider)); return true;
          case 'setup/models':
            if (!runtime.setup) throw new Error('setup_unavailable');
            json(response, 200, await runtime.setup.refreshModels()); return true;
          case 'start': await runtime.start(); break;
          case 'mute': runtime.controller.mute(); break;
          case 'unmute': runtime.controller.unmute(); break;
          case 'stop': runtime.setup?.cancelMetadata(); await runtime.stop(); break;
          case 'invalidate':
            if (!Number.isSafeInteger(input.view_seq) || input.view_seq < 1) throw new Error('invalid_view_sequence');
            runtime.invalidateView(input.view_seq); break;
          case 'observe':
            if (typeof input.match_id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.match_id) ||
              typeof input.anchor !== 'string' || !/^T\d+-A\d+$/.test(input.anchor) ||
              !Number.isSafeInteger(input.view_seq) || input.view_seq < 1 || !Number.isSafeInteger(input.game_number) || input.game_number < 1 || !['before','after'].includes(input.boundary)) throw new Error('invalid_view');
            await runtime.observeView(input); break;
          case 'playback': runtime.controller.acknowledge(input); break;
          default: json(response, 404, { error: 'Unknown coach action.' }); return true;
        }
        json(response, 200, runtime.snapshot());
      } catch { json(response, 400, { error: 'Coach action could not be completed. Check local configuration or replay anchor.' }); }
      return true;
    },
    async close() { runtime.controller.off('event', forward); runtime.setup?.cancelMetadata(); await runtime.stop(); for (const client of clients) client.end(); clients.clear(); }
  };
}
