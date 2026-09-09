'use strict';

const debug = require('./debug');

const DEFAULT_TIMEOUT_MS = 20000;

function normalizeBase(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  url = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function describeError(err) {
  if (!err) return 'Unknown error';
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `DNS lookup failed (${code}) — the hostname could not be resolved.`;
  }
  if (code === 'ECONNREFUSED') {
    return 'Connection refused — nothing is listening on that address/port.';
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `Network timeout / unreachable (${code}). Check firewall and that Seerr binds an accessible interface.`;
  }
  if (err.name === 'AbortError') {
    return 'Request timed out.';
  }
  if (err instanceof TypeError && /fetch/i.test(String(err.message))) {
    return `Network layer error: ${err.message}`;
  }
  return err.message || String(err);
}

function parseStatus(body) {
  if (!body || typeof body !== 'object') return false;
  return !!body.version;
}

/**
 * RFC3986-compliant query-value encoding.
 * URLSearchParams encodes spaces as '+', but Jellyseerr/Overseerr's
 * OpenAPI validator rejects '+' (and other reserved chars) with
 * "must be url encoded. Its value may not contain reserved characters."
 */
function encodeQueryValue(value) {
  const s = String(value == null ? '' : value);
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

class SeerrApi {
  constructor(config) {
    this.config = config;
    this._userToken = null;
    this._userEmail = null;
    this._userTried = false;
  }

  settings() {
    return this.config.seerr || {};
  }

  isConfigured() {
    const s = this.settings();
    return !!s.url && (!!(s.apiKey) || !!(s.impersonate && s.impersonate.email && s.impersonate.password));
  }

  isEnabled() {
    const s = this.settings();
    return s.enabled && this.isConfigured();
  }

  async ensureUserAuth(configOverride) {
    const s = this.settings();
    const imp = (configOverride && configOverride.impersonate) || s.impersonate || {};
    if (!imp.email || !imp.password) return null;
    if (this._userToken && this._userEmail === imp.email && !this._userTried) {
      return this._userToken;
    }
    return this.login(imp.email, imp.password, configOverride);
  }

  async login(email, password, configOverride) {
    const eff = this.effective(configOverride);
    let base = this.baseUrl(eff);
    if (!base) throw new Error('Seerr URL not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const record = {
      dir: 'seerr-request',
      method: 'POST',
      path: '/api/v1/auth/local',
      url: `${base}/api/v1/auth/local`,
      requestBody: debug.truncate({ email, password: '***' }),
      response: '',
      status: null,
      durationMs: 0,
      error: null
    };
    try {
      const startedAt = Date.now();
      const res = await fetch(`${base}/api/v1/auth/local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      });
      record.durationMs = Date.now() - startedAt;
      record.status = res.status;

      const contentType = res.headers.get('content-type') || '';
      const bodyText = contentType.includes('application/json') ? JSON.stringify(await res.json().catch(() => null)) : await res.text();
      if (!res.ok) {
        record.error = `Seerr login failed (${res.status}): ${debug.truncate(bodyText || res.statusText)}`;
        debug.log(record);
        this._userTried = true;
        throw new Error(record.error);
      }

      const cookie = res.headers.get('set-cookie') || '';
      const apiResponse = contentType.includes('application/json') ? await res.json().catch(() => null) : null;

      let token = '';
      if (cookie && /connect\.sid=/i.test(cookie)) {
        const m = cookie.match(/connect\.sid=([^;]+)/i);
        if (m) token = m[1];
      }
      if (!token && apiResponse && apiResponse.token) token = apiResponse.token;
      if (!token && apiResponse && apiResponse.apiKey) token = apiResponse.apiKey;

      const userEmail = (apiResponse && (apiResponse.email || apiResponse.username)) || email;
      if (!token) {
        record.error = 'Seerr login succeeded but no session token was returned. Enable API-key or session login on the Seerr side, or use the API Key field instead of impersonation.';
        debug.log(record);
        throw new Error(record.error);
      }

      record.response = debug.truncate({
        user: userEmail,
        id: apiResponse && apiResponse.id,
        hasToken: true
      });
      debug.log(record);
      this._userToken = token;
      this._userEmail = userEmail;
      this._userTried = false;
      return token;
    } catch (e) {
      if (!(e instanceof Error && e.message && e.message.startsWith('Seerr login failed'))) {
        const described = describeError(e);
        record.error = described;
        debug.log(record);
        throw new Error(described);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  effective(params) {
    if (params && (params.url || params.apiKey || (params.impersonate && params.impersonate.email))) {
      return { ...this.settings(), ...params };
    }
    return this.settings();
  }

  baseUrl(configOverride) {
    const eff = this.effective(configOverride);
    return normalizeBase(eff.url);
  }

  hasImpersonation(configOverride) {
    const eff = this.effective(configOverride);
    const imp = eff.impersonate || {};
    return !!(imp.email && imp.password);
  }

  async fetchJson(path, options = {}, configOverride) {
    const eff = this.effective(configOverride);
    let base = this.baseUrl(eff);
    if (!base) throw new Error('Seerr URL not configured');

    const usingImpersonation = this.hasImpersonation(eff);
    const url = `${base}${path}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      let token = '';
      if (usingImpersonation) {
        token = await this.ensureUserAuth(eff);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      const record = {
        dir: 'seerr-request',
        method: (options.method || 'GET').toUpperCase(),
        path,
        url,
        requestBody: debug.truncate(options.body),
        response: '',
        status: null,
        durationMs: 0,
        error: null,
        as: usingImpersonation ? this._userEmail || 'impersonated' : 'api-key'
      };

      try {
        const startedAt = Date.now();
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (usingImpersonation) {
          headers['Cookie'] = `connect.sid=${token}`;
        } else {
          headers['X-Api-Key'] = eff.apiKey || '';
        }

        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers
        });

        record.status = res.status;
        record.durationMs = Date.now() - startedAt;

        const contentType = res.headers.get('content-type') || '';
        const body = contentType.includes('application/json')
          ? await res.json()
          : await res.text();

        record.response = debug.truncate(body);

        if (!res.ok) {
          if (
            usingImpersonation &&
            (res.status === 401 || res.status === 403) &&
            attempt === 0
          ) {
            this._userToken = null;
            this._userTried = false;
            record.error = `Retrying as user (session ${res.status}: ${debug.truncate(body)})`;
            debug.log(record);
            continue;
          }
          throw new Error(`Seerr API error ${res.status}: ${debug.truncate(body)}`);
        }
        return body;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Seerr API error')) {
          record.error = e.message;
        } else {
          const described = describeError(e);
          record.error = described;
          if (!(e instanceof Error) || e.message !== described) {
            e = new Error(described);
          }
        }
        throw e;
      } finally {
        clearTimeout(timer);
        debug.log(record);
      }
    }
  }

  async search(query, mediaType = 'all', configOverride) {
    const parts = [`query=${encodeQueryValue(query)}`];
    return this.fetchJson(`/api/v1/search?${parts.join('&')}`, {}, configOverride);
  }

  async status(configOverride) {
    return this.fetchJson('/api/v1/status', {}, configOverride);
  }

  async requestByTitle(title, mediaType, configOverride) {
    const results = await this.search(title, mediaType, configOverride);
    const items = results && Array.isArray(results.results) ? results.results : [];
    if (items.length === 0) {
      throw new Error(`No results found for "${title}"`);
    }
    if (mediaType && mediaType !== 'all') {
      const match = items.find((r) => r.mediaType === mediaType) || items.find((r) => !r.mediaType);
      if (match) return match;
    }
    return items[0];
  }

  async requestMovie(title, configOverride) {
    const media = await this.requestByTitle(title, 'movie', configOverride);
    return this.submitRequest({ mediaType: 'movie', mediaId: media.id }, configOverride);
  }

  async requestTv(title, configOverride) {
    const media = await this.requestByTitle(title, 'tv', configOverride);
    return this.submitRequest({ mediaType: 'tv', mediaId: media.id }, configOverride);
  }

  async submitRequest(payload, configOverride) {
    const body = Object.assign({}, payload);
    if (body.mediaType === 'tv' && body.seasons === undefined) {
      body.seasons = 'all';
    }
    return this.fetchJson('/api/v1/request', {
      method: 'POST',
      body: JSON.stringify(body)
    }, configOverride);
  }

  async requestByTitleSmart(title, configOverride) {
    try {
      return { type: 'movie', result: await this.requestMovie(title, configOverride) };
    } catch (e) {
      return { type: 'tv', result: await this.requestTv(title, configOverride) };
    }
  }

  async test(configOverride) {
    const eff = this.effective(configOverride);
    const checks = [];

    const setResult = (name, ok, detail) => checks.push({ name, ok, detail });
    const base = this.baseUrl(eff);

    if (!base) {
      setResult('URL configured', false, 'No Seerr URL set');
      setResult('API key configured', !!eff.apiKey, eff.apiKey ? 'set' : 'missing');
      return {
        ok: false,
        url: '',
        apiKey: eff.apiKey ? 'set' : 'missing',
        enabled: !!eff.enabled,
        checks
      };
    }

    let statusOk = false;
    let statusDetail = '';
    try {
      const status = await this.status({ ...eff, url: base });
      statusOk = parseStatus(status);
      statusDetail = statusOk
        ? `Version ${status.version}${status.commitTag ? ` (${status.commitTag})` : ''}${status.name ? ` — ${status.name}` : ''}`
        : 'Reachable, but the response was not a Seerr API';
    } catch (e) {
      statusDetail = e.message;
      if (/localhost|127\.0\.0\.1/.test(base) && /refused|resolve|timeout|unreachable|labor/i.test(e.message)) {
        statusDetail += ' — tip: inside a container, localhost is not your host. Use the host LAN IP or host.docker.internal.';
      } else if (/host\.docker\.internal/.test(base) && /resolve/i.test(e.message)) {
        statusDetail += ' — tip: host.docker.internal is not mapped in this container. Use the host LAN IP, or add --add-host host.docker.internal:host-gateway at runtime.';
      }
    }
    setResult('Seerr reachable', statusOk, statusDetail);

    let authOk = false;
    let authDetail = '';
    if (statusOk) {
      try {
        const results = await this.search('test', 'all', { ...eff, url: base });
        authOk = true;
        authDetail = this._userEmail
          ? `Authenticated as ${this._userEmail} — search returned ${(results.results || []).length} result(s)`
          : `API key accepted — search returned ${(results.results || []).length} result(s)`;
      } catch (e) {
        authDetail = e.message;
        if (/401|403/.test(e.message)) {
          authDetail = this.hasImpersonation(eff)
            ? 'Impersonation login or session rejected (401/403). Check the email/password and that the user may access Seerr.'
            : 'API key rejected (401/403). Double-check the key in Seerr → Settings → General.';
        }
      }
      setResult(this.hasImpersonation(eff) ? 'User login valid' : 'API key valid', authOk, authDetail);
    }

    const ok = statusOk && authOk;
    return {
      ok,
      url: base,
      apiKey: eff.apiKey ? 'set' : 'missing',
      impersonating: this._userEmail || (this.hasImpersonation(eff) ? 'pending' : false),
      enabled: !!eff.enabled,
      checks
    };
  }
}

module.exports = SeerrApi;