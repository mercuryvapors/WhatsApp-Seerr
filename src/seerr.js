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

class SeerrApi {
  constructor(config) {
    this.config = config;
    this._baseCache = new Map();
  }

  settings() {
    return this.config.seerr || {};
  }

  isConfigured() {
    const s = this.settings();
    return !!(s.url && s.apiKey);
  }

  isEnabled() {
    const s = this.settings();
    return s.enabled && this.isConfigured();
  }

  effective(params) {
    if (params && (params.url || params.apiKey)) {
      return { ...this.settings(), ...params };
    }
    return this.settings();
  }

  baseUrl(configOverride) {
    const eff = this.effective(configOverride);
    return normalizeBase(eff.url);
  }

  async fetchJson(path, options = {}, configOverride) {
    const eff = this.effective(configOverride);
    let base = this.baseUrl(eff);
    if (!base) throw new Error('Seerr URL not configured');

    const cacheKey = `${eff.url}|${eff.apiKey}`;
    const url = `${base}${path}`;

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
      error: null
    };

    try {
      const startedAt = Date.now();
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'X-Api-Key': eff.apiKey || '',
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      record.status = res.status;
      record.durationMs = Date.now() - startedAt;

      const contentType = res.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await res.json()
        : await res.text();

      record.response = debug.truncate(body);

      if (!res.ok) {
        throw new Error(`Seerr API error ${res.status}: ${debug.truncate(body)}`);
      }
      this._baseCache.set(cacheKey, base);
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

  async search(query, mediaType = 'all', configOverride) {
    const params = new URLSearchParams({ query });
    if (mediaType && mediaType !== 'all') params.set('mediaType', mediaType);
    return this.fetchJson(`/api/v1/search?${params.toString()}`, {}, configOverride);
  }

  async status(configOverride) {
    return this.fetchJson('/api/v1/status', {}, configOverride);
  }

  async requestByTitle(title, mediaType, configOverride) {
    const results = await this.search(title, mediaType, configOverride);
    if (!results || !Array.isArray(results.results) || results.results.length === 0) {
      throw new Error(`No results found for "${title}"`);
    }
    return results.results[0];
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
    return this.fetchJson('/api/v1/request', {
      method: 'POST',
      body: JSON.stringify(payload)
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
        authDetail = `API key accepted — search returned ${(results.results || []).length} result(s)`;
      } catch (e) {
        authDetail = e.message;
        if (/401|403/.test(e.message)) {
          authDetail = 'API key rejected (401/403). Double-check the key in Seerr → Settings → General.';
        }
      }
      setResult('API key valid', authOk, authDetail);
    }

    const ok = statusOk && authOk;
    return {
      ok,
      url: base,
      apiKey: eff.apiKey ? 'set' : 'missing',
      enabled: !!eff.enabled,
      checks
    };
  }
}

module.exports = SeerrApi;