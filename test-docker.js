'use strict';
/**
 * Tests the Docker API client (src/docker.js) against a mock Docker daemon
 * listening on a unix socket. No real Docker required.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockermock-'));
const sockPath = path.join(sockDir, 'docker.sock');
process.env.DOCKER_HOST = `unix://${sockPath}`;

const seen = { requests: [], inspectCalls: 0, restartCalls: 0 };
const ID = 'a'.repeat(64);

const server = http.createServer((req, res) => {
  seen.requests.push(`${req.method} ${req.url}`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && /\/containers\/([^/]+)\/json$/.test(req.url)) {
      const name = decodeURIComponent(/\/containers\/([^/]+)\/json$/.exec(req.url)[1]);
      if (name !== ID && name !== 'whatsapp-seerr') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: 'No such container: ' + name }));
        return;
      }
      seen.inspectCalls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        Id: ID,
        Name: '/whatsapp-seerr',
        Config: { Image: 'ghcr.io/mercuryvapors/whatsapp-seerr:latest' },
        State: { Status: 'running', Pid: 4242 },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }
      }));
      return;
    }
    if (req.method === 'POST' && /\/containers\/[^/]+\/restart/.test(req.url)) {
      seen.restartCalls++;
      // Simulate the daemon tearing the caller down mid-request: reset the
      // connection instead of replying.
      res.socket.destroy();
      return;
    }
    if (req.method === 'GET' && /\/containers\/json/.test(req.url)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([
        { Id: 'b'.repeat(64), Names: ['/other'], State: { Pid: 999 } }
      ]));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

(async () => {
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const docker = require('./src/docker');

  // --- socket detection
  assert.strictEqual(docker.hasSocket(), true, 'socket detected via DOCKER_HOST');
  assert.strictEqual(docker.socketPath(), sockPath);

  // --- inspect
  const info = await docker.inspect('whatsapp-seerr');
  assert.strictEqual(info.name, 'whatsapp-seerr');
  assert.strictEqual(info.restartPolicy, 'unless-stopped');
  assert.strictEqual(info.status, 'running');
  assert.strictEqual(info.id, ID);

  // --- detectContainer (id supplied explicitly for the test)
  process.env.DOCKER_CONTAINER_ID = ID;
  const detected = await docker.detectContainer();
  assert.strictEqual(detected.available, true);
  assert.strictEqual(detected.name, 'whatsapp-seerr');
  assert.strictEqual(detected.restartPolicy, 'unless-stopped');
  delete process.env.DOCKER_CONTAINER_ID;

  // --- restartContainer: the daemon kills our connection, which must be
  //     treated as a successful restart rather than an error.
  process.env.DOCKER_CONTAINER_ID = ID;
  const result = await docker.restartContainer(30);
  assert.strictEqual(result.name, 'whatsapp-seerr');
  assert.strictEqual(seen.restartCalls, 1, 'restart endpoint called exactly once');
  assert.ok(
    seen.requests.some((r) => r === `POST /v1.41/containers/${ID}/restart?t=30`),
    `restart URL correct, saw: ${JSON.stringify(seen.requests)}`
  );
  delete process.env.DOCKER_CONTAINER_ID;

  // --- a real API error must still surface
  const bad = await docker.inspect('does-not-exist-404').catch((e) => e);
  assert.ok(bad instanceof Error, '404 surfaces as an error');
  assert.ok(/404/.test(bad.message), `error mentions status, got: ${bad.message}`);

  // --- container id detection from the various runtime layouts
  const fake = (map) => (p) => {
    if (map[p] === undefined) throw new Error('ENOENT ' + p);
    return map[p];
  };
  const id = 'c'.repeat(64);

  // cgroup v2: the id shows up in mountinfo
  assert.strictEqual(
    docker.detectContainerId(fake({
      '/proc/self/mountinfo': `123 456 0:44 /containers/${id}/hostname /etc/hostname rw - ext4 /dev/sda1 rw`,
      '/proc/self/cgroup': '0::/\n',
      '/etc/hostname': 'whatsapp-seerr'
    })),
    id,
    'id detected from mountinfo'
  );

  // cgroup v1: the id shows up in cgroup
  assert.strictEqual(
    docker.detectContainerId(fake({
      '/proc/self/mountinfo': 'nothing useful here',
      '/proc/self/cgroup': `12:memory:/docker/${id}`,
      '/etc/hostname': 'whatsapp-seerr'
    })),
    id,
    'id detected from cgroup'
  );

  // fallback: hostname is the short id
  assert.strictEqual(
    docker.detectContainerId(fake({
      '/proc/self/mountinfo': 'nothing',
      '/proc/self/cgroup': '0::/',
      '/etc/hostname': 'abc123def456'
    })),
    'abc123def456',
    'short id detected from hostname'
  );

  // a friendly hostname is not an id
  assert.strictEqual(
    docker.detectContainerId(fake({
      '/proc/self/mountinfo': 'nothing',
      '/proc/self/cgroup': '0::/',
      '/etc/hostname': 'my-nas'
    })),
    null,
    'friendly hostname is not treated as an id'
  );

  // --- init host pid from NSpid
  assert.strictEqual(
    docker.initHostPid(fake({ '/proc/1/status': 'Name:\tnode\nNSpid:\t4242\t1\n' })),
    4242,
    'init host pid read from NSpid'
  );
  assert.strictEqual(
    docker.hostPid(fake({ '/proc/self/status': 'Name:\tnode\nNSpid:\t900\t12\n' })),
    900,
    'self host pid read from NSpid'
  );

  // --- no socket -> graceful, actionable error
  process.env.DOCKER_HOST = 'unix:///nonexistent/docker.sock';
  delete require.cache[require.resolve('./src/docker')];
  const dockerNoSock = require('./src/docker');
  assert.strictEqual(dockerNoSock.hasSocket(), false, 'no socket detected');
  const noSock = await dockerNoSock.detectContainer();
  assert.strictEqual(noSock.available, false);
  assert.ok(/socket/i.test(noSock.reason), `reason mentions socket: ${noSock.reason}`);
  const fail = await dockerNoSock.restartContainer().catch((e) => e);
  assert.ok(fail instanceof Error, 'restart throws without a socket');

  console.log('DOCKER API ALL PASS');
  server.close();
  fs.rmSync(sockDir, { recursive: true, force: true });
})().catch((e) => {
  console.error('FAIL:', e.message);
  server.close();
  process.exit(1);
});
