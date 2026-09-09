const http = require('http');
const SeerrApi = require('./src/seerr');

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/v1/status')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: '1.90.0', commitTag: 'abc', name: 'Overseerr' }));
      } else if (req.url.startsWith('/api/v1/search')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results: [{ id: 1, mediaType: 'movie', title: 'Dune' }] }));
      } else if (req.url.startsWith('/api/v1/request') && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 99, requestedBy: 'x' }));
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startMock();
  const port = server.address().port;
  const cfg = {
    server: {},
    whatsapp: {},
    seerr: { url: `http://127.0.0.1:${port}`, apiKey: 'secret', enabled: true },
    app: { name: 'test' }
  };
  const api = new SeerrApi(cfg);

  console.log('--- test() ---');
  const result = await api.test();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) throw new Error('test() failed');

  console.log('--- no-scheme URL normalization ---');
  const cfg2 = { ...cfg, seerr: { ...cfg.seerr, url: '127.0.0.1:' + port } };
  const api2 = new SeerrApi(cfg2);
  const t2 = await api2.test({ url: '127.0.0.1:' + port, apiKey: 'secret', enabled: true });
  console.log('normalized url:', t2.url);
  if (!t2.ok) throw new Error('normalization test failed');

  console.log('--- requestMovie ---');
  const api3 = new SeerrApi(cfg);
  const req = await api3.requestMovie('Dune');
  console.log('request response id:', req.id);
  if (req.id !== 99) throw new Error('requestMovie failed');

  console.log('--- bad URL error messaging ---');
  const api4 = new SeerrApi({ ...cfg, seerr: { ...cfg.seerr, url: 'http://localhost:9' } });
  const t4 = await api4.test({ url: 'http://localhost:9', apiKey: 'k', enabled: true });
  console.log(JSON.stringify(t4.checks, null, 2));
  if (t4.ok) throw new Error('expected failure');

  server.close();
  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });