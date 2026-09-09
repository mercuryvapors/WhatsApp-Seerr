'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const debug = require('./debug');

class WhatsAppBot {
  constructor(cfg, callbacks) {
    this.cfg = cfg;
    this.callbacks = callbacks || {};
    this.client = null;
    this.qr = null;
    this.status = 'idle';
    this.lastError = null;
    this.isRunning = false;
  }

  getStatus() {
    return {
      status: this.status,
      qr: this.qr,
      error: this.lastError,
      configured: !!(this.cfg.whatsapp && this.cfg.whatsapp.enabled)
    };
  }

  isAllowedNumber(number) {
    const allowed = this.cfg.whatsapp.allowedNumbers || [];
    if (allowed.length === 0) return true;
    const normalized = number.replace(/\D/g, '');
    return allowed.some((n) => {
      const clean = n.toString().replace(/\D/g, '');
      return clean === normalized || normalized.endsWith(clean);
    });
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.status = 'connecting';
    this.lastError = null;
    this.qr = null;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.initClient();
        return;
      } catch (e) {
        this.lastError = e.message;
        console.error(`WhatsApp client init attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
        if (this.client) {
          try { await this.client.destroy(); } catch (_) {}
          this.client = null;
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
    }
    this.status = 'error';
    this.isRunning = false;
    console.error('Failed to initialize WhatsApp client:', this.lastError);
  }

  clearStaleProfileLocks() {
    const dataPath = this.cfg.whatsapp.sessionFile || './data/wa-session';
    const profileDir = path.join(dataPath, 'session');
    try {
      if (!fs.existsSync(profileDir)) return;
      const lockFiles = fs
        .readdirSync(profileDir)
        .filter((f) => /^Singleton/.test(f));
      if (lockFiles.length > 0) {
        for (const f of lockFiles) {
          fs.rmSync(path.join(profileDir, f), { force: true });
        }
        console.log(
          `Removed stale Chromium profile lock(s) in ${profileDir}: ${lockFiles.join(', ')}`
        );
      }
    } catch (e) {
      console.warn('Could not clear stale profile locks:', e.message);
    }
  }

  async initClient() {
    this.clearStaleProfileLocks();

    const puppeteerOpts = {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    };

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.cfg.whatsapp.sessionFile || './data/wa-session'
      }),
      puppeteer: {
        ...puppeteerOpts,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions'
        ]
      }
    });

      this.client.on('qr', (qr) => {
      this.status = 'waiting_qr';
      this.qr = qr;
      if (this.callbacks.onQr) this.callbacks.onQr(qr);
      console.log('QR code received. Scan with WhatsApp.');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => {
      this.status = 'authenticated';
      console.log('WhatsApp authenticated.');
    });

    this.client.on('auth_failure', (msg) => {
      this.status = 'auth_failure';
      this.lastError = `Auth failure: ${msg}`;
      console.error('WhatsApp auth failure:', msg);
    });

    this.client.on('ready', () => {
      this.status = 'ready';
      let own = '';
      try {
        own = (this.client.info && this.client.info.wid && (this.client.info.wid.user || '')) || '';
      } catch (_) {}
      this.selfNumber = own.replace(/\D/g, '');
      console.log('WhatsApp client is ready!' + (own ? ' (own number: ' + own + ')' : ''));
      this.startSelfChatPoller();
      if (this.callbacks.onReady) this.callbacks.onReady();
    });

    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.lastError = `Disconnected: ${reason}`;
      console.log('WhatsApp disconnected:', reason);
      if (this.callbacks.onDisconnect) this.callbacks.onDisconnect(reason);
    });

    this.client.on('message', (message) => this.handleMessage(message));
    this.client.on('message_create', (message) => this.handleMessage(message));

    await this.client.initialize();
  }

  async stop() {
    this.isRunning = false;
    if (this._poller) {
      clearInterval(this._poller);
      this._poller = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {
        console.error('Error destroying client:', e.message);
      }
      this.client = null;
    }
    this.status = 'stopped';
  }

  _msgId(message) {
    return (message && message.id && (message.id._serialized || message.id.id)) || null;
  }

  _isDeduped(message) {
    const id = this._msgId(message) || `${Date.now()}-${(message.body || '').slice(0, 20)}`;
    if (this._seenMsgIds && this._seenMsgIds.has(id)) return false;
    if (!this._seenMsgIds) this._seenMsgIds = new Set();
    this._seenMsgIds.add(id);
    if (this._seenMsgIds.size > 5000) {
      const first = this._seenMsgIds.values().next().value;
      this._seenMsgIds.delete(first);
    }
    return true;
  }

  startSelfChatPoller() {
    if (this._poller) return;
    if (this.cfg.whatsapp && this.cfg.whatsapp.allowSelfMessages === false) return;
    this._pollSeen = this._pollSeen || new Set();
    this._poller = setInterval(() => this.pollSelfChat(), 4000);
    console.log('Self-chat poller started (checks \'Message Yourself\' every 4s).');
    this.pollSelfChat();
  }

  async pollSelfChat() {
    if (!this.client || this.status !== 'ready') return;
    if (this._polling) return;
    this._polling = true;
    try {
      let target = null;
      const info = this.client.info || {};
      const selfUser = (info.wid && info.wid.user) || '';
      if (info.wid && info.wid._serialized) {
        try {
          target = await this.client.getChatById(info.wid._serialized);
        } catch (_) {}
      }
      if (!target && selfUser) {
        try {
          const chats = await this.client.getChats();
          target = chats.find((c) => !c.isGroup && c.id && (c.id.user || '') === selfUser) || null;
        } catch (_) {}
      }
      if (!target) return;

      let messages = [];
      try {
        messages = await target.fetchMessages({ limit: 30 });
      } catch (e) {
        console.warn('Self-chat fetchMessages failed:', e.message);
        return;
      }

      for (const m of messages) {
        if (!m.fromMe) continue;
        const id = this._msgId(m);
        if (id && this._pollSeen.has(id)) continue;
        if (id) this._pollSeen.add(id);
        if (this._pollSeen.size > 5000) {
          const first = this._pollSeen.values().next().value;
          this._pollSeen.delete(first);
        }
        await this.handleMessage(m, true);
      }
    } catch (e) {
      console.warn('Self-chat poll error:', e.message);
    } finally {
      this._polling = false;
    }
  }

  async handleMessage(message, isSelfChatHint) {
    try {
      if (!this.cfg.whatsapp || !this.cfg.whatsapp.enabled) {
        debug.log({ dir: 'whatsapp-recv', number: this._num(message), body: debug.truncate(message.body, 200), reason: 'skipped: bot disabled' });
        return;
      }

      if (!this._isDeduped(message)) return;

      const number = this._num(message);
      const toNum = this._num({ from: message.to });
      const isSelfChat = !!isSelfChatHint || (message.fromMe && !!number && (toNum === number || (!toNum && number === this.selfNumber)));
      const allowSelf = this.cfg.whatsapp.allowSelfMessages !== false;

      if (message.fromMe && !(allowSelf && isSelfChat)) {
        debug.log({ dir: 'whatsapp-recv', number, body: debug.truncate(message.body, 200), reason: 'skipped: outgoing message not to self' });
        return;
      }

      const text = (message.body || '').trim();
      if (isSelfChat) {
        debug.log({ dir: 'self-test', number, body: debug.truncate(message.body, 200) });
      } else {
        if (message.isGroup) {
          debug.log({ dir: 'whatsapp-recv', number, body: debug.truncate(message.body, 200), reason: 'skipped: group message (groups not supported)' });
          return;
        }
        if (!this.isAllowedNumber(number)) {
          debug.log({ dir: 'whatsapp-recv', number, body: debug.truncate(message.body, 200), reason: 'skipped: number not in allowed list' });
          return;
        }
      }

      debug.log({ dir: 'whatsapp-recv', number, body: debug.truncate(message.body, 200) });
      const prefix = this.cfg.whatsapp.commandPrefix || '!';
      if (!text.startsWith(prefix)) return;

      const commandLine = text.slice(prefix.length).trim();
      if (!commandLine) return;

      let command = commandLine;
      let args = '';
      const spaceIdx = commandLine.indexOf(' ');
      if (spaceIdx >= 0) {
        command = commandLine.slice(0, spaceIdx);
        args = commandLine.slice(spaceIdx + 1).trim();
      }

      const cmd = command.toLowerCase();
      debug.log({ dir: 'whatsapp-command', number, cmd, args: debug.truncate(args, 200) });

      let chat = null;
      try {
        chat = await message.getChat();
      } catch (e) {
        console.warn('Could not resolve chat for message, continuing without it:', e.message);
      }

      if (this.callbacks.onCommand) {
        await this.callbacks.onCommand({
          cmd,
          args,
          raw: commandLine,
          message,
          chat,
          number,
          isSelfTest: isSelfChat,
          reply: async (textMessage) => {
            debug.log({ dir: 'whatsapp-reply', number, body: debug.truncate(textMessage, 200) });
            try {
              return await message.reply(textMessage);
            } catch (e) {
              console.warn('message.reply failed, falling back to sendMessage:', e.message);
              return this.client.sendMessage(message.from, textMessage);
            }
          }
        });
      }
    } catch (e) {
      console.error('Error handling message:', e);
      debug.log({ dir: 'whatsapp-recv', number: message.from || '?', body: debug.truncate(message.body, 200), reason: 'error: ' + e.message });
    }
  }

  _num(message) {
    const from = message.from || '';
    const idx = from.indexOf('@');
    return idx >= 0 ? from.slice(0, idx) : from;
  }

  _isDeduped(message) {
    const id = (message.id && (message.id.id || message.id._serialized)) || `${Date.now()}-${(message.body || '').slice(0, 20)}`;
    if (this._seenMsgIds && this._seenMsgIds.has(id)) return false;
    if (!this._seenMsgIds) this._seenMsgIds = new Set();
    this._seenMsgIds.add(id);
    if (this._seenMsgIds.size > 5000) {
      const first = this._seenMsgIds.values().next().value;
      this._seenMsgIds.delete(first);
    }
    return true;
  }
}

module.exports = WhatsAppBot;
