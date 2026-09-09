'use strict';
const WhatsAppBot = require('./src/whatsapp');
const debug = require('./src/debug');

function makeMsg(overrides) {
  return {
    id: { id: '3EB0FAKE', fromMe: true, _serialized: '3EB0FAKE' },
    fromMe: true,
    from: '15551234567@c.us',
    to: 'unknown@c.us',
    body: '!test',
    isGroup: false,
    reply: async () => {},
    getChat: async () => null,
    ...overrides
  };
}

const seen = [];
const bot = new WhatsAppBot(
  { whatsapp: { enabled: true, commandPrefix: '!', allowedNumbers: [], allowSelfMessages: true } },
  { onCommand: async (ctx) => { bot.gotCmd = ctx; } }
);
bot.client = { info: { wid: { _serialized: '15551234567@c.us', user: '15551234567' }, pushname: 'Bob' } };
bot.updateOwnIds();
debug.clear();

const run = (m) => bot.handleMessage(m);

(async () => {
  // 1) Own self-chat message (classic c.us)
  await run(makeMsg({ to: '15551234567@c.us' }));
  console.log('1 classic self-msg:', bot.gotCmd ? 'TRIGGERED' : 'not triggered');

  // 2) LID-style self message (same digits, @lid)
  await run(makeMsg({ id: { id: 'LIDFAKE', fromMe: true, _serialized: 'LIDFAKE' }, from: '15551234567@lid', to: '15551234567@lid' }));
  console.log('2 lid self-msg:   ', bot.gotCmd ? 'TRIGGERED' : 'not triggered');

  // 3) Own message to a DIFFERENT number must be skipped
  const before = bot.gotCmd;
  await run(makeMsg({ id: { id: 'OUTGOING', fromMe: true, _serialized: 'OUTGOING' }, to: '14445550000@c.us' }));
  console.log('3 to-other:        ', bot.gotCmd === before ? 'skipped' : 'WRONGLY TRIGGERED');

  // 4) Incoming from a friend (not fromMe) must still work (message event path)
  await run(makeMsg({ id: { id: 'INCOMING', fromMe: false, _serialized: 'INCOMING' }, from: '14445550000@c.us', fromMe: false }));
  console.log('4 incoming friend: ', bot.gotCmd ? 'TRIGGERED' : 'not triggered');

  // 5) allowSelfMessages=false blocks self-chat
  bot.cfg.whatsapp.allowSelfMessages = false;
  const before5 = bot.gotCmd;
  await run(makeMsg({ id: { id: 'SELFOFF', fromMe: true, _serialized: 'SELFOFF' }, to: '15551234567@c.us' }));
  console.log('5 allowSelf=off:   ', bot.gotCmd === before5 ? 'skipped' : 'WRONGLY TRIGGERED');
  bot.cfg.whatsapp.allowSelfMessages = true;

  // 6) dedup: same message id twice -> processed once
  bot._seenMsgIds.clear();
  let cmdCount = 0;
  bot.callbacks.onCommand = async () => cmdCount++;
  const dup = makeMsg({ to: '15551234567@c.us' });
  await run(dup);
  await run(dup);
  console.log('6 dedup:           ', cmdCount === 1 ? 'processed once' : `processed ${cmdCount}x`);

  // 7) Self-chat id resolved by poller differs from raw number digits
  //    (message.to is the true self-chat id; ownIds contain it via _selfChatId)
  bot.callbacks.onCommand = async () => { bot.gotCmd = 'resolved'; };
  bot._seenMsgIds.clear();
  bot._selfChatId = '12897001910@c.us';
  bot.updateOwnIds();
  await run(makeMsg({ id: { id: 'RESOLVED', fromMe: true, _serialized: 'RESOLVED' }, from: '12897001910@c.us', to: '12897001910@c.us' }));
  console.log('7 resolved self:   ', bot.gotCmd === 'resolved' ? 'TRIGGERED' : 'not triggered');

  // 8) ownIds must NOT swallow outgoing to a non-self contact
  bot._seenMsgIds.clear();
  bot._ownIds.clear();
  bot._ownIds.add('12897001910@lid');
  bot._ownIds.add('12897001910@c.us');
  let triggered = false;
  bot.callbacks.onCommand = async () => { triggered = true; };
  await run(makeMsg({ id: { id: 'OUT2', fromMe: true, _serialized: 'OUT2' }, from: '15551234567@c.us', to: '14445550000@lid' }));
  console.log('8 ownIds other-to: ', triggered ? 'WRONGLY TRIGGERED' : 'skipped');

  // 9) Authoritative chat-contact.isMe: quick check misses it, chat says it's me
  bot.cfg.whatsapp.allowSelfMessages = true;
  bot._seenMsgIds.clear();
  bot.gotCmd = null;
  bot.callbacks.onCommand = async () => { bot.gotCmd = 'isme'; };
  bot._ownIds.clear();
  bot.updateOwnIds();
  await run(makeMsg({
    id: { id: 'ISME', fromMe: true, _serialized: 'ISME' },
    from: '12897001910@c.us',
    to: '12897001910-something@c.us',
    getChat: async () => ({ id: { _serialized: '12897001910-something@c.us' }, getContact: async () => ({ isMe: true }) })
  }));
  console.log('9 authoritative isMe:', bot.gotCmd ? 'TRIGGERED' : 'not triggered');

  // 10) Authoritative chat-contact.isMe false: outgoing to a real friend must skip
  bot._seenMsgIds.clear();
  triggered = false;
  bot.callbacks.onCommand = async () => { triggered = true; };
  await run(makeMsg({
    id: { id: 'NOTME', fromMe: true, _serialized: 'NOTME' },
    from: '12897001910@c.us',
    to: '14445550000@c.us',
    getChat: async () => ({ id: { _serialized: '14445550000@c.us' }, getContact: async () => ({ isMe: false }) })
  }));
  console.log('10 authoritative !me: ', triggered ? 'WRONGLY TRIGGERED' : 'skipped');

  // 11) to === from (byte-identical JID) is self regardless of c.us/lid digits
  bot.cfg.whatsapp.allowSelfMessages = true;
  bot._seenMsgIds.clear();
  bot.gotCmd = null;
  bot.callbacks.onCommand = async () => { bot.gotCmd = 'samejid'; };
  await run(makeMsg({
    id: { id: 'SAMEJID', fromMe: true, _serialized: 'SAMEJID' },
    from: '12897001910@lid',
    to: '12897001910@lid',
    getChat: async () => ({ id: { _serialized: '12897001910@lid' }, getContact: async () => ({ isMe: false }) })
  }));
  console.log('11 to===from:      ', bot.gotCmd === 'samejid' ? 'TRIGGERED' : 'not triggered');

  const fails = [];
  const all = debug.all();
  if (!(all.some((e) => e.reason === 'processing as self-test'))) fails.push('no processing-as-self-test log');
  if (!(all.some((e) => e.reason === 'skipped: outgoing message not to self'))) fails.push('no skip log');
  if (fails.length) {
    console.log('FAIL:', fails.join('; '));
    process.exit(1);
  }
  console.log('ALL PASS');
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });