'use strict';
/**
 * Integration test for the auto-restart flow:
 *   - 'container' mode uses the Docker API to restart the container
 *   - a failed Docker restart falls back to exiting the process
 *   - 'bot' mode only reconnects the WhatsApp client
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockermock-'));
const sockPath = path.join(sockDir, 'docker.sock');
process.env.DOCKER_HOST = `unix://${sockPath}`;
process.env.DOCKER_CONTAINER_ID = 'd'.repeat(64);

let restartHits = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && /\/containers\/[^/]+\/json$/.test(req.url)) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      Id: 'd'.repeat(64),
      Name: '/whatsapp-seerr',
      State: { Status: 'running', Pid: 4242 },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }
    }));
    return;
  }
  if (req.method === 'POST' && /\/containers\/[^/]+\/restart/.test(req.url)) {
    restartHits++;
    res.socket.destroy(); // the daemon kills us mid-call
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

(async () => {
  await new Promise((r) => server.listen(sockPath, r));

  const { AutoRestarter } = require('./src/restart');
  const docker = require('./src/docker');

  // --- container mode: goes through the Docker API, never through the
  //     exit-based fallback.
  let cfg = { server: { autoRestart: { enabled: true, time: '04:00', mode: 'container' } } };
  let exitFallbackCalled = false;
  const r = new AutoRestarter({
    getConfig: () => cfg,
    // mirrors src/index.js: stop the bot, then ask Docker to restart us
    onContainerRestart: async () => { await docker.restartContainer(30); },
    onRestart: async () => { exitFallbackCalled = true; }
  });

  await r.trigger('manual');
  assert.strictEqual(exitFallbackCalled, false, 'container mode must not fall through to exit');
  assert.strictEqual(restartHits, 1, 'Docker restart endpoint called once');

  // --- a failing Docker restart falls back to the exit path
  let exitFallbackCalled2 = false;
  const r2 = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { throw new Error('Docker socket not mounted'); },
    onRestart: async () => { exitFallbackCalled2 = true; }
  });
  await r2.trigger('manual');
  assert.strictEqual(exitFallbackCalled2, true, 'failed Docker restart falls back to exit');
  assert.ok(r2.status().error.includes('Docker socket'), `error surfaced: ${r2.status().error}`);

  // --- bot mode: only the in-place path
  let containerRestartCalled = false;
  let botFallbackCalled = false;
  cfg = { server: { autoRestart: { enabled: true, time: '04:00', mode: 'bot' } } };
  const r3 = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { containerRestartCalled = true; },
    onRestart: async () => { botFallbackCalled = true; }
  });
  await r3.trigger('manual');
  assert.strictEqual(botFallbackCalled, true, 'bot mode uses the in-place path');
  assert.strictEqual(containerRestartCalled, false, 'bot mode must not touch Docker');

  // --- status exposes the Docker info for the UI
  await r.refreshContainerInfo();
  const st = r.status();
  assert.strictEqual(st.docker.socket, true, 'status reports the socket');
  assert.strictEqual(st.docker.container, 'whatsapp-seerr', 'status reports the container name');
  assert.strictEqual(st.docker.restartPolicy, 'unless-stopped', 'status reports the restart policy');

  console.log('RESTART INTEGRATION ALL PASS');
  server.close();
  fs.rmSync(sockDir, { recursive: true, force: true });
})().catch((e) => {
  console.error('FAIL:', e.message);
  server.close();
  process.exit(1);
});
