// Contract: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// This owns a separate registration and never reads Codex/browser credentials.
import { createServer } from 'node:http';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { privateJsonRead, privateJsonWrite, operationSignal, checkedJson, ProviderBlockedError } from './common.mjs';
import { validateGrant } from './budget.mjs';

export const SIWC_ENDPOINTS = Object.freeze({ discovery: 'https://auth.openai.com/.well-known/openid-configuration', authorize: 'https://auth.openai.com/api/accounts/authorize', token: 'https://auth.openai.com/api/accounts/oauth/token', jwks: 'https://auth.openai.com/.well-known/jwks.json', resource: 'https://api.openai.com/v1' });
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const constantEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function verifyIdToken(idToken, { jwks, issuer, clientId, nonce, subject, now = Date.now() } = {}) {
  if (typeof idToken !== 'string' || idToken.length > 65536) throw new ProviderBlockedError('invalid_id_token', 'Missing or oversized OpenAI identity token.');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ProviderBlockedError('invalid_id_token', 'Invalid OpenAI identity token.');
  let header;
  let claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new ProviderBlockedError('invalid_id_token', 'Malformed OpenAI identity token.'); }
  if (!header || !claims || typeof header.kid !== 'string' || typeof claims !== 'object') throw new ProviderBlockedError('invalid_id_token', 'Malformed OpenAI identity token claims.');
  const algorithm = { RS256: 'RSA-SHA256', ES256: 'sha256' }[header.alg];
  if (!algorithm || header.crit?.length) throw new ProviderBlockedError('invalid_id_token', 'Unsupported identity token signature.');
  const jwk = jwks?.keys?.find(key => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
  if (!jwk || (header.alg === 'RS256' && jwk.kty !== 'RSA') || (header.alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256'))) throw new ProviderBlockedError('invalid_id_token', 'Identity token key was not found.');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = verify(algorithm, Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const time = Math.floor(now / 1000);
  if (!valid || claims.iss !== issuer || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= time || (claims.nbf != null && claims.nbf > time + 30) || !claims.sub || typeof claims.sub !== 'string' || (nonce !== undefined && !constantEqual(claims.nonce, nonce)) || (subject !== undefined && claims.sub !== subject)) throw new ProviderBlockedError('invalid_id_token', 'OpenAI identity validation failed.');
  return claims;
}

export class SiwcAuth {
  constructor({ configDir = join(homedir(), '.config', 'mtga-live-coach'), grant = {}, fetchImpl = globalThis.fetch, appName = 'MTGA Live Coach' } = {}) {
    this.configDir = configDir;
    this.grant = validateGrant(grant);
    this.fetchImpl = fetchImpl;
    this.appName = appName;
    this.hostPath = join(configDir, 'siwc-host.json');
    this.activePath = join(configDir, 'siwc-active.json');
    this.pendingPath = join(configDir, 'siwc-pending-registration.json');
    this.refreshing = null;
    this.authorizing = false;
  }

  #authorized() {
    if (!this.grant.approved || !this.grant.plan) throw new ProviderBlockedError('authorization_required', 'SIWC registration and plan usage need explicit authorization.');
    if (this.grant.expiresAt && Date.parse(this.grant.expiresAt) <= Date.now()) throw new ProviderBlockedError('grant_expired', 'The SIWC grant has expired.');
  }

  #account() {
    const selected = privateJsonRead(this.activePath);
    if (!selected) return null;
    if (!/^[a-f0-9]{64}$/.test(selected.registration)) throw new ProviderBlockedError('invalid_registration', 'Invalid selected SIWC registration.');
    const record = privateJsonRead(join(this.configDir, 'siwc-accounts', selected.registration, 'credentials.json'));
    if (!record || typeof record.client_id !== 'string' || !record.client_id || record.client_id === 'dynamic_agent_client' || typeof record.subject !== 'string' || !record.subject || typeof record.access_token !== 'string' || !record.access_token || typeof record.refresh_token !== 'string' || !record.refresh_token || !Array.isArray(record.scopes) || !Number.isFinite(record.expires_in) || record.expires_in <= 0 || !Number.isFinite(Date.parse(record.saved_at))) throw new ProviderBlockedError('invalid_registration', 'Incomplete SIWC registration.');
    return record;
  }

  #save(record) {
    const registration = createHash('sha256').update(`${record.issuer}\0${record.subject}\0${record.client_id}`).digest('hex');
    privateJsonWrite(join(this.configDir, 'siwc-accounts', registration, 'credentials.json'), record);
    privateJsonWrite(this.activePath, { registration });
  }

  async #identity(tokens, { clientId, nonce, subject, signal }) {
    const discovery = await checkedJson(await this.fetchImpl(SIWC_ENDPOINTS.discovery, { signal }), 'OpenAI discovery');
    if (discovery.issuer !== 'https://auth.openai.com' || discovery.jwks_uri !== SIWC_ENDPOINTS.jwks || discovery.token_endpoint !== SIWC_ENDPOINTS.token || discovery.authorization_endpoint !== SIWC_ENDPOINTS.authorize) throw new ProviderBlockedError('invalid_discovery', 'Unexpected OpenAI discovery endpoint; sign-in stopped.');
    const jwks = await checkedJson(await this.fetchImpl(discovery.jwks_uri, { signal }), 'OpenAI JWKS');
    return verifyIdToken(tokens.id_token, { jwks, issuer: discovery.issuer, clientId, nonce, subject });
  }

  async startAuthorization({ signal, timeoutMs = 180000, newAccount = false } = {}) {
    this.#authorized();
    signal?.throwIfAborted();
    if (this.authorizing) throw new ProviderBlockedError('authorization_busy', 'A SIWC sign-in is already pending.');
    this.authorizing = true;
    let previous;
    let host;
    let pendingRegistration;
    try {
      previous = newAccount ? null : this.#account();
      host = privateJsonRead(this.hostPath) ?? { ext_agent_host_id: `urn:uuid:${randomUUID()}` };
      if (typeof host.ext_agent_host_id !== 'string' || !host.ext_agent_host_id.startsWith('urn:uuid:')) throw new ProviderBlockedError('invalid_host', 'Invalid persisted SIWC host identity.');
      privateJsonWrite(this.hostPath, host);
      pendingRegistration = previous || newAccount ? null : privateJsonRead(this.pendingPath);
      if (pendingRegistration && (typeof pendingRegistration.client_id !== 'string' || !pendingRegistration.client_id || pendingRegistration.client_id === 'dynamic_agent_client' || pendingRegistration.ext_agent_host_id !== host.ext_agent_host_id)) throw new ProviderBlockedError('invalid_registration', 'Invalid pending SIWC registration.');
    } catch (error) { this.authorizing = false; throw error; }
    const operation = operationSignal(signal, timeoutMs);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const selectedClientId = previous?.client_id ?? pendingRegistration?.client_id ?? 'dynamic_agent_client';
    let resolveCompletion;
    let rejectCompletion;
    let consumed = false;
    const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    // Attach a rejection handler immediately; CLI may open a browser before awaiting completion.
    completion.catch(() => {});
    const server = createServer(async (request, response) => {
      const callback = new URL(request.url, redirectUri);
      if (request.method !== 'GET' || callback.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
      if (consumed || !constantEqual(callback.searchParams.get('state'), state)) { response.writeHead(400).end('Invalid sign-in state.'); return; }
      consumed = true;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      try {
        operation.signal.throwIfAborted();
        if (callback.searchParams.has('error')) throw new ProviderBlockedError('sign_in_declined', 'OpenAI sign-in was declined or unavailable.');
        const clientId = callback.searchParams.get('client_id') ?? (selectedClientId === 'dynamic_agent_client' ? null : selectedClientId);
        const code = callback.searchParams.get('code');
        if (!clientId || clientId === 'dynamic_agent_client' || !code || (selectedClientId !== 'dynamic_agent_client' && clientId !== selectedClientId)) throw new ProviderBlockedError('invalid_registration', 'SIWC returned an incomplete or changed client registration.');
        // Keep an issued registration even if code exchange fails. It is never an authenticated
        // account until the signed identity and scopes are validated below.
        if (!previous) privateJsonWrite(this.pendingPath, { client_id: clientId, ext_agent_host_id: host.ext_agent_host_id });
        const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: SIWC_ENDPOINTS.resource });
        const tokens = await checkedJson(await this.fetchImpl(SIWC_ENDPOINTS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: operation.signal }), 'SIWC token exchange');
        const identity = await this.#identity(tokens, { clientId, nonce, subject: previous?.subject, signal: operation.signal });
        const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
        if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke') || !tokens.access_token || !tokens.refresh_token || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new ProviderBlockedError('plan_permission_missing', 'The returned grant does not enable ChatGPT plan inference.');
        const record = { issuer: identity.iss, subject: identity.sub, email: identity.email ?? null, client_id: clientId, ext_agent_host_id: host.ext_agent_host_id, id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_type: 'Bearer', scopes, expires_in: tokens.expires_in, saved_at: new Date().toISOString() };
        operation.signal.throwIfAborted();
        this.#save(record);
        try { unlinkSync(this.pendingPath); } catch (error) { if (error.code !== 'ENOENT') throw new ProviderBlockedError('private_storage_failed', 'SIWC registration cleanup failed.'); }
        response.writeHead(200).end('MTGA Live Coach sign-in complete. You can close this tab.');
        resolveCompletion(this.summary());
      } catch (error) { response.writeHead(400).end('Sign-in failed. Check the local coach status.'); rejectCompletion(error); }
      finally { cleanup(); }
    });
    let redirectUri;
    const onAbort = () => { rejectCompletion(operation.signal.reason); cleanup(); };
    const cleanup = () => { operation.dispose(); operation.signal.removeEventListener('abort', onAbort); server.closeAllConnections(); server.close(); this.authorizing = false; };
    operation.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      operation.signal.throwIfAborted();
      redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(SIWC_ENDPOINTS.authorize);
      const parameters = { client_id: selectedClientId, ext_agent_host_id: host.ext_agent_host_id, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), resource: SIWC_ENDPOINTS.resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (selectedClientId === 'dynamic_agent_client') parameters.agent_name_hint = this.appName;
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      return { url: url.toString(), redirectUri, completion, cancel: () => operation.abort(new DOMException('Sign-in canceled.', 'AbortError')) };
    } catch (error) { cleanup(); rejectCompletion(error); throw error; }
  }

  async accessToken({ signal } = {}) {
    this.#authorized();
    signal?.throwIfAborted();
    const account = this.#account();
    if (!account) throw new ProviderBlockedError('sign_in_required', 'Continue with ChatGPT before using the plan model.');
    if (!account.scopes?.includes('chatgpt.tokens.use.direct') || !account.scopes.includes('resource.invoke')) throw new ProviderBlockedError('plan_permission_missing', 'Saved credentials do not grant plan inference.');
    const expiresAt = Date.parse(account.saved_at) + account.expires_in * 1000;
    if (!Number.isFinite(expiresAt)) throw new ProviderBlockedError('invalid_registration', 'Saved SIWC expiry is invalid.');
    if (expiresAt > Date.now() + 60000) return account.access_token;
    if (!this.refreshing) {
      this.refreshing = this.#refresh(account, signal).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async #refresh(account, signal) {
    const operation = operationSignal(signal, 15000);
    const lockPath = join(this.configDir, 'siwc-refresh.lock');
    let lock;
    try {
      try { lock = openSync(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new ProviderBlockedError('refresh_busy', 'Another process is refreshing this SIWC session; no token request was sent.'); throw new ProviderBlockedError('refresh_unavailable', 'SIWC refresh lock could not be created.'); }
      const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: SIWC_ENDPOINTS.resource });
      const tokens = await checkedJson(await this.fetchImpl(SIWC_ENDPOINTS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: operation.signal }), 'SIWC refresh');
      const scopes = tokens.scope ? tokens.scope.split(/\s+/) : account.scopes;
      if (!tokens.access_token || !tokens.refresh_token || (tokens.token_type && String(tokens.token_type).toLowerCase() !== 'bearer') || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || !scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new ProviderBlockedError('plan_permission_missing', 'Renewed SIWC grant cannot be used for inference.');
      if (tokens.id_token) await this.#identity(tokens, { clientId: account.client_id, subject: account.subject, signal: operation.signal });
      const updated = { ...account, ...tokens, scopes, saved_at: new Date().toISOString() };
      operation.signal.throwIfAborted();
      this.#save(updated);
      return updated.access_token;
    } finally { operation.dispose(); if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); } }
  }

  summary() {
    const account = this.#account();
    return account ? { signedIn: true, source: 'SIWC ChatGPT plan', modelBackend: 'https://api.openai.com/v1/responses', expiresAt: new Date(Date.parse(account.saved_at) + account.expires_in * 1000).toISOString(), scopes: account.scopes, paidApiFallback: false } : { signedIn: false, source: 'SIWC ChatGPT plan', paidApiFallback: false };
  }

  catalogKey() { return privateJsonRead(this.activePath)?.registration ?? null; }
}
