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

  async request(path, options = {}) {
    const base = this.baseUrl();
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
      error: null
    };

    try {
      const res = await fetch(`${base}${path}`, {
        ...options,
        headers: this.headers(options.headers)
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

  async search(query, mediaType = 'all') {
    const params = new URLSearchParams({ query });
    if (mediaType && mediaType !== 'all') params.set('mediaType', mediaType);
    return this.request(`/api/v1/search?${params.toString()}`);
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

  async test() {
    const checks = [];
    const base = this.baseUrl();

    if (!base) {
      return {
        ok: false,
        url: '',
        apiKey: this.config.seerr.apiKey ? 'set' : 'missing',
        checks: [
          { name: 'URL configured', ok: false, detail: 'No Seerr URL set' },
          { name: 'API key configured', ok: !!this.config.seerr.apiKey, detail: this.config.seerr.apiKey ? 'set' : 'missing' }
        ]
      };
    }

    let statusDetail = '';
    let statusOk = false;
    try {
      const status = await this.request('/api/v1/status');
      statusOk = !!status.version;
      statusDetail = status.version
        ? `Version ${status.version} (${status.commitTag || 'n/a'})${status.name ? ' — ' + status.name : ''}`
        : 'Reachable, but not a Seerr API';
    } catch (e) {
      statusDetail = e.message;
    }
    checks.push({ name: 'Seerr reachable', ok: statusOk, detail: statusDetail });

    let authOk = false;
    let authDetail = '';
    if (statusOk) {
      try {
        const results = await this.search('test');
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
      apiKey: this.config.seerr.apiKey ? 'set' : 'missing',
      enabled: !!this.config.seerr.enabled,
      checks
    };
  }
}

module.exports = SeerrApi;
