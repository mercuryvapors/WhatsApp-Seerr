'use strict';
/**
 * Verifies the !request result-list prompt text (range formatting).
 */
const { handleCommand, seerr } = require('./src/index');

seerr.isEnabled = () => true;

const items = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    mediaType: 'movie',
    title: `Movie ${i + 1}`,
    releaseDate: '2024-01-01',
    posterPath: '/p.jpg'
  }));

(async () => {
  const cases = [1, 2, 5];
  for (const n of cases) {
    seerr.search = async () => ({ results: items(n) });
    const out = [];
    await handleCommand({
      cmd: 'request',
      args: 'movie Dune',
      number: '15551230000',
      reply: async (t) => out.push(t),
      replyImage: async () => {}
    });
    const text = out.join('\n');
    const hint = text.split('\n').filter((l) => l.includes('!pick')).pop();
    console.log(`--- ${n} result(s) ---`);
    console.log(hint);
    if (hint !== `Reply *!pick 1 of ${n}* to request one.`) {
      console.error('UNEXPECTED HINT');
      process.exit(1);
    }
  }

  // the hint must still parse: "!pick 1 of 1" and "!pick 2 of 5"
  seerr.search = async () => ({ results: items(5) });
  await handleCommand({ cmd: 'request', args: 'movie Dune', number: '15551230001', reply: async () => {}, replyImage: async () => {} });
  const picked = [];
  await handleCommand({
    cmd: 'pick',
    args: '2 of 5',
    number: '15551230001',
    reply: async (t) => picked.push(t),
    replyImage: async (u, t) => picked.push(t)
  });
  console.log('--- pick "2 of 5" ---');
  console.log(picked.join('\n').split('\n')[0]);
  if (!/Movie 2/.test(picked.join('\n'))) {
    console.error('PICK WITH "of" DID NOT RESOLVE');
    process.exit(1);
  }

  console.log('PICK PROMPT ALL PASS');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
