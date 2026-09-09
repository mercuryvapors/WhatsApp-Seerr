const http = require('http');
const SeerrApi = require('./src/seerr');

function startMock() {
  return new Promise((resolve) => {
    const seen = { cookies: [], apiKeys: [], requests: [] };
    const server = http.createServer((req, res) => {
      const cookie = req.headers.cookie || '';
      const cookies = (cookie.match(/connect\.sid=([^;]+)/g) || []).map((c) => c);
      const apiKey = (req.headers['x-api-key'] || '').toString();
      if (cookies.length) seen.cookies.push(cookies);
      if (apiKey) seen.apiKeys.push(apiKey);

      if (req.url === '/api/v1/auth/local' && req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          const body = JSON.parse(b);
          res.setHeader('Content-Type', 'application/json');
          if (body.email === 'bob@home' && body.password === 'pw') {
            res.setHeader('Set-Cookie', 'connect.sid=s%3Auser-bobby; Path=/; HttpOnly');
            res.end(JSON.stringify({ id: 7, email: 'bob@home', username: 'bobby', plexUsername: 'bobby' }));
          } else {
            res.statusCode = 403;
            res.end(JSON.stringify({ message: 'Access denied.' }));
          }
        });
        return;
      }
      if (req.url.startsWith('/api/v1/status')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: '1.90.0', commitTag: 'abc', name: 'Overseerr' }));
        return;
      }
      if (req.url.startsWith('/api/v1/search')) {
        const u = new URL(req.url, 'http://mock');
        if (u.searchParams.has('mediaType')) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: "unknown query parameter 'mediaType'" }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results: [{ id: 1, mediaType: 'movie', title: 'Dune' }] }));
        return;
      }
      if (req.url.startsWith('/api/v1/request') && req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          seen.requests.push({ body: JSON.parse(b), cookie: cookie, apiKey });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ id: 99, requestedBy: 'x' }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen }));
  });
}

(async () => {
  const { server, seen } = await startMock();
  const port = server.address().port;
  const cfg = {
    server: {},
    whatsapp: {},
    seerr: { url: `http://127.0.0.1:${port}`, apiKey: 'secret', enabled: true, type: 'overseerr' },
    app: { name: 'test' }
  };
  const api = new SeerrApi(cfg);

  console.log('--- test() with only API key ---');
  const result = await api.test();
  console.log('ok:', result.ok, '| check:', result.checks[0].name, result.checks[0].detail);
  if (!result.ok) throw new Error('test() failed');

  console.log('--- no-scheme URL normalization ---');
  const cfg2 = { ...cfg, seerr: { ...cfg.seerr, url: '127.0.0.1:' + port } };
  const api2 = new SeerrApi(cfg2);
  const t2 = await api2.test({ url: '127.0.0.1:' + port, apiKey: 'secret', enabled: true });
  console.log('normalized url:', t2.url);
  if (!t2.ok) throw new Error('normalization test failed');

  console.log('--- requestMovie via API key ---');
  const api3 = new SeerrApi(cfg);
  const req = await api3.requestMovie('Dune');
  console.log('request response id:', req.id);
  if (req.id !== 99) throw new Error('requestMovie failed');
  if (seen.apiKeys.length === 0) throw new Error('expected api key header');
  if (seen.cookies.length !== 0) throw new Error('did not expect cookie without impersonation');

  console.log('--- impersonation: search + request use the user session ---');
  const apiImp = new SeerrApi({
    ...cfg,
    seerr: {
      ...cfg.seerr,
      apiKey: '',
      impersonate: { email: 'bob@home', password: 'pw' }
    }
  });
  const t5 = await apiImp.test();
  console.log('test ok:', t5.ok, '| impersonating:', t5.impersonating, '| check:', JSON.stringify(t5.checks.map(c => [c.name, c.ok, c.detail])));
  if (!t5.ok) throw new Error('impersonation test() failed');
  if (t5.impersonating !== 'bob@home') throw new Error('expected impersonating bob@home');

  const reqImp = await apiImp.requestMovie('Dune');
  console.log('request response id:', reqImp.id);
  const reqRecord = seen.requests[seen.requests.length - 1];
  console.log('request sent with cookie:', JSON.stringify(reqRecord.cookie), '| apiKey:', JSON.stringify(reqRecord.apiKey));
  if (!/connect\.sid=/.test(reqRecord.cookie)) throw new Error('expected session cookie on request');
  if (reqRecord.apiKey) throw new Error('did not expect api key on impersonated request');

  console.log('--- tv request includes seasons:\'all\' ---');
  const apiTv = new SeerrApi({ ...cfg, seerr: { ...cfg.seerr, apiKey: 'secret' } });
  // requestTv picks the tv match from search then submits
  await apiTv.requestTv('Goliath');
  const tvReq = seen.requests[seen.requests.length - 1];
  console.log('tv request body:', JSON.stringify(tvReq.body));
  if (tvReq.body.mediaType !== 'tv') throw new Error('expected tv mediaType');
  if (tvReq.body.seasons !== 'all') throw new Error('tv request must include seasons=\'all\' (Seerr 500s without it)');

  console.log('--- direct submitRequest defaults seasons for tv ---');
  const apiSub = new SeerrApi(cfg);
  await apiSub.submitRequest({ mediaType: 'tv', mediaId: 77 });
  const subReq = seen.requests[seen.requests.length - 1];
  if (subReq.body.seasons !== 'all') throw new Error('submitRequest should default tv seasons to all');

  console.log('--- bad URL error messaging ---');
  const api4 = new SeerrApi({ ...cfg, seerr: { ...cfg.seerr, url: 'http://localhost:9' } });
  const t4 = await api4.test({ url: 'http://localhost:9', apiKey: 'k', enabled: true });
  console.log(JSON.stringify(t4.checks, null, 2));
  if (t4.ok) throw new Error('expected failure');

  server.close();
  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });