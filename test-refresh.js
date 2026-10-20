'use strict';
/**
 * Tests the in-place refresh path and the container-mode fallback rules.
 */
const assert = require('assert');
const { AutoRestarter } = require('./src/restart');

(async () => {
  // --- 'refresh' mode: never touches the container, never exits
  let cfg = { server: { autoRestart: { enabled: true, time: '04:00', mode: 'refresh' } } };
  let containerCalls = 0;
  let inPlaceCalls = 0;
  const r = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { containerCalls++; },
    onRestart: async (reason, s) => { inPlaceCalls++; }
  });

  await r.trigger('manual');
  assert.strictEqual(inPlaceCalls, 1, 'refresh mode uses the in-place path');
  assert.strictEqual(containerCalls, 0, 'refresh mode must not touch Docker');

  // --- 'auto' outside Docker resolves to 'refresh' (not 'bot')
  const auto = new AutoRestarter({
    getConfig: () => ({ server: { autoRestart: { enabled: true, time: '04:00', mode: 'auto' } } }),
    onRestart: async () => {}
  });
  assert.strictEqual(auto.settings().resolvedMode, 'refresh', 'auto outside Docker -> refresh');

  // --- 'bot' mode still only does the in-place path
  cfg = { server: { autoRestart: { enabled: true, time: '04:00', mode: 'bot' } } };
  let botCalls = 0;
  const rBot = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { containerCalls++; },
    onRestart: async () => { botCalls++; }
  });
  await rBot.trigger('manual');
  assert.strictEqual(botCalls, 1, 'bot mode uses the in-place path');
  assert.strictEqual(containerCalls, 0, 'bot mode must not touch Docker');

  // --- container mode with a working Docker API: uses it, no fallback
  cfg = { server: { autoRestart: { enabled: true, time: '04:00', mode: 'container' } } };
  let containerOk = 0;
  let fallback = 0;
  const rOk = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { containerOk++; },
    onRestart: async () => { fallback++; }
  });
  await rOk.trigger('manual');
  assert.strictEqual(containerOk, 1, 'container mode uses the Docker path');
  assert.strictEqual(fallback, 0, 'container mode must not fall through when Docker works');

  // --- container mode with a broken Docker API: falls back, error surfaced
  let fallback2 = 0;
  const rBad = new AutoRestarter({
    getConfig: () => cfg,
    onContainerRestart: async () => { throw new Error('Docker socket not mounted'); },
    onRestart: async () => { fallback2++; }
  });
  await rBad.trigger('manual');
  assert.strictEqual(fallback2, 1, 'broken Docker API falls back');
  assert.ok(rBad.status().error.includes('Docker socket'), `error surfaced: ${rBad.status().error}`);

  // --- the seerr session cache can be cleared
  const SeerrApi = require('./src/seerr');
  const api = new SeerrApi({ seerr: { url: 'http://x', apiKey: 'k' } });
  api._sessions.set('a@b', { token: 't' });
  api._userEmail = 'a@b';
  const cleared = api.clearSessions();
  assert.strictEqual(cleared, 1, 'reports how many sessions were dropped');
  assert.strictEqual(api._sessions.size, 0, 'sessions cleared');
  assert.strictEqual(api._userEmail, null, 'active user cleared');

  console.log('IN-PLACE REFRESH ALL PASS');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
