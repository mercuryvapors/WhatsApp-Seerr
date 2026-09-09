const http = require('http');
const SeerrApi = require('./src/seerr');

function startMock() {
  return new Promise((resolve) => {
    const seen = { cookies: [], apiKeys: [], requests: [], searches: [], logins: [] };
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
            seen.logins.push('bob');
            res.end(JSON.stringify({ id: 7, email: 'bob@home', username: 'bobby', plexUsername: 'bobby' }));
          } else if (body.email === 'carol@home' && body.password === 'carolpw') {
            res.setHeader('Set-Cookie', 'connect.sid=s%3Auser-carol; Path=/; HttpOnly');
            seen.logins.push('carol');
            res.end(JSON.stringify({ id: 8, email: 'carol@home', username: 'carol', plexUsername: 'carol' }));
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
        seen.searches.push({ cookie, apiKey });
        if (u.searchParams.has('mediaType')) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: "unknown query parameter 'mediaType'" }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results: [
          { id: 1, mediaType: 'movie', title: 'Dune', tmdbId: 1 },
          { id: 312, mediaType: 'tv', name: 'Goliath', tmdbId: 7 }
        ] }));
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

  console.log('--- tv request includes seasons:\'all\' + tmdb mediaId ---');
  const apiTv = new SeerrApi({ ...cfg, seerr: { ...cfg.seerr, apiKey: 'secret' } });
  // requestTv picks the tv match from search then submits
  await apiTv.requestTv('Goliath');
  const tvReq = seen.requests[seen.requests.length - 1];
  console.log('tv request body:', JSON.stringify(tvReq.body));
  if (tvReq.body.mediaType !== 'tv') throw new Error('expected tv mediaType');
  if (tvReq.body.seasons !== 'all') throw new Error('tv request must include seasons=\'all\' (Seerr 500s without it)');
  if (tvReq.body.mediaId !== 7) throw new Error('tv request must use the TMDB id as mediaId (search returns tvdb id as id; Seerr treats mediaId as tmdbId for tv)');
  if (tvReq.body.tvdbId !== 312) throw new Error('expected tvdbId to be sent explicitly');

  console.log('--- direct submitRequest defaults seasons for tv ---');
  const apiSub = new SeerrApi(cfg);
  await apiSub.submitRequest({ mediaType: 'tv', mediaId: 77 });
  const subReq = seen.requests[seen.requests.length - 1];
  if (subReq.body.seasons !== 'all') throw new Error('submitRequest should default tv seasons to all');

  console.log('--- per-user cookie mapping ---');
  const loginsBefore = seen.logins.length;
  const apiU = new SeerrApi({
    ...cfg,
    seerr: {
      ...cfg.seerr,
      apiKey: '',
      impersonate: { email: 'bob@home', password: 'pw' },
      users: [
        { number: '15551234567', email: 'bob@home', password: 'pw' },
        { number: '15559998888', email: 'carol@home', password: 'carolpw' }
      ]
    }
  });
  await apiU.search('Dune', 'all', undefined, '15559998888');
  const carolRec = seen.searches[seen.searches.length - 1];
  console.log('carol search cookie:', carolRec.cookie);
  if (!/connect\.sid=s%3Auser-carol/.test(carolRec.cookie)) throw new Error('expected carol session cookie for 15559998888');

  await apiU.search('Dune', 'all', undefined, '15559998888');
  console.log('carol logins so far:', seen.logins.slice(loginsBefore));
  if (seen.logins.length !== loginsBefore + 1) throw new Error('expected carol to be logged in exactly once (session cached)');

  await apiU.submitRequest({ mediaType: 'movie', mediaId: 5 }, undefined, '15559998888');
  const pickRec = seen.requests[seen.requests.length - 1];
  if (!/connect\.sid=s%3Auser-carol/.test(pickRec.cookie)) throw new Error('expected carol cookie on submitRequest');

  await apiU.search('Dune', 'all', undefined, '15551234567');
  const bobRec = seen.searches[seen.searches.length - 1];
  if (!/connect\.sid=s%3Auser-bobby/.test(bobRec.cookie)) throw new Error('expected bob session cookie for 15551234567');

  await apiU.search('Dune', 'all', undefined, '10001');
  const unmappedRec = seen.searches[seen.searches.length - 1];
  console.log('unmapped falls back to:', unmappedRec.cookie);
  if (!/connect\.sid=s%3Auser-bobby/.test(unmappedRec.cookie)) throw new Error('expected impersonate fallback cookie for unmapped number');

  console.log('--- bad URL error messaging ---');
  const api4 = new SeerrApi({ ...cfg, seerr: { ...cfg.seerr, url: 'http://localhost:9' } });
  const t4 = await api4.test({ url: 'http://localhost:9', apiKey: 'k', enabled: true });
  console.log(JSON.stringify(t4.checks, null, 2));
  if (t4.ok) throw new Error('expected failure');

  server.close();
  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });