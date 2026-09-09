const debug = require('./debug');

class SeerrApi {
  constructor(config) {
    this.config = config;
  }

  baseUrl() {
    const url = (this.config.seerr.url || '').replace(/\/+$/, '');
    return url;
  }

  headers(extra) {
    return {
      'X-Api-Key': this.config.seerr.apiKey || '',
      'Content-Type': 'application/json',
      ...extra
    };
  }

  isConfigured() {
    return !!(this.config.seerr.url && this.config.seerr.apiKey);
  }

  isEnabled() {
    return this.config.seerr.enabled && this.isConfigured();
  }

  async request(path, options = {}, configOverride) {
    const eff = configOverride || this.config.seerr;
    const base = (eff.url || '').replace(/\/+$/, '');
    if (!base) throw new Error('Seerr URL not configured');

    const started = Date.now();
    const record = {
      dir: 'seerr-request',
      method: (options.method || 'GET').toUpperCase(),
      path,
      requestBody: debug.truncate(options.body),
      response: '',
      status: null,
      durationMs: 0,
      error: null,
      base: base
    };

    try {
      const res = await fetch(`${base}${path}`, {
        ...options,
        headers: {
          'X-Api-Key': eff.apiKey || '',
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      record.status = res.status;
      record.durationMs = Date.now() - started;
      const contentType = res.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await res.json() : await res.text();
      record.response = debug.truncate(body);
      if (!res.ok) {
        throw new Error(`Seerr API error ${res.status}: ${debug.truncate(body)}`);
      }
      return body;
    } catch (e) {
      record.error = debug.truncate(e.message);
      if (!record.status && !record.durationMs) record.durationMs = Date.now() - started;
      debug.log(record);
      throw e;
    } finally {
      if (!record.error) debug.log(record);
    }
  }

  async search(query, mediaType = 'all', configOverride) {
    const params = new URLSearchParams({ query });
    if (mediaType && mediaType !== 'all') params.set('mediaType', mediaType);
    return this.request(`/api/v1/search?${params.toString()}`, {}, configOverride);
  }

  async requestByTitle(title, mediaType) {
    const results = await this.search(title, mediaType);
    if (!results || !Array.isArray(results.results) || results.results.length === 0) {
      throw new Error(`No results found for "${title}"`);
    }
    const first = results.results[0];
    return first;
  }

  async requestMovie(title) {
    const media = await this.requestByTitle(title, 'movie');
    return this.request(`/api/v1/request`, {
      method: 'POST',
      body: JSON.stringify({ mediaType: 'movie', mediaId: media.id })
    });
  }

  async requestTv(title) {
    const media = await this.requestByTitle(title, 'tv');
    return this.request(`/api/v1/request`, {
      method: 'POST',
      body: JSON.stringify({ mediaType: 'tv', mediaId: media.id })
    });
  }

  async requestByCommand(title, prefix) {
    const lower = title.toLowerCase();
    let mediaType = null;
    if (lower.startsWith('movie')) {
      mediaType = 'movie';
      title = title.replace(/^movie/i, '').trim();
    } else if (lower.startsWith('tv') || lower.startsWith('show') || lower.startsWith('series')) {
      mediaType = 'tv';
      title = title.replace(/^((tv|show|series)\b)/i, '').trim();
    }
    if (mediaType === 'tv') {
      return this.requestTv(title);
    }
    if (mediaType === 'movie') {
      return this.requestMovie(title);
    }
    return this.requestMovie(title);
  }

  async requestType(type) {
    return type === 'tv' ? this.requestTv.bind(this) : this.requestMovie.bind(this);
  }

  async test(overrides) {
    const checks = [];
    const saved = this.config.seerr;
    const merged = overrides && (overrides.url || overrides.apiKey || 'enabled' in overrides)
      ? { ...saved, ...overrides }
      : saved;
    const base = (merged.url || '').replace(/\/+$/, '');

    if (!base) {
      return {
        ok: false,
        url: '',
        apiKey: merged.apiKey ? 'set' : 'missing',
        checks: [
          { name: 'URL configured', ok: false, detail: 'No Seerr URL set' },
          { name: 'API key configured', ok: !!merged.apiKey, detail: merged.apiKey ? 'set' : 'missing' }
        ]
      };
    }

    let statusDetail = '';
    let statusOk = false;
    try {
      const status = await this.request('/api/v1/status', {}, { ...saved, url: base, apiKey: merged.apiKey });
      statusOk = !!status.version;
      statusDetail = status.version
        ? `Version ${status.version} (${status.commitTag || 'n/a'})${status.name ? ' — ' + status.name : ''}`
        : 'Reachable, but not a Seerr API';
    } catch (e) {
      statusDetail = e.message;
      const host = base.replace(/^[^:]+:\/\//, '').split('/')[0];
      if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
        statusDetail += ' — tip: inside the container, localhost is this container, not your host. Use the host IP or host.docker.internal.';
      } else if (host.startsWith('host.docker.internal') && /getaddrinfo|ENOTFOUND|fetch failed/i.test(e.message)) {
        statusDetail += ' — tip: host.docker.internal is not mapped. Use your host LAN IP (e.g. http://192.168.1.50:5055), or run with --add-host host.docker.internal:host-gateway.';
      }
    }
    checks.push({ name: 'Seerr reachable', ok: statusOk, detail: statusDetail });

    let authOk = false;
    let authDetail = '';
    if (statusOk) {
      try {
        const results = await this.search('test', null, { ...saved, url: base, apiKey: merged.apiKey });
        authOk = true;
        authDetail = `API key accepted — search returned ${(results.results || []).length} result(s)`;
      } catch (e) {
        authDetail = e.message;
        if (/401|403/i.test(e.message)) {
          authDetail = 'API key rejected (401/403). Double-check the key in Seerr → Settings → General.';
        }
      }
      checks.push({ name: 'API key valid', ok: authOk, detail: authDetail });
    }

    const ok = statusOk && authOk;
    return {
      ok,
      url: base,
      apiKey: merged.apiKey ? 'set' : 'missing',
      enabled: !!merged.enabled,
      checks
    };
  }
}

module.exports = SeerrApi;
