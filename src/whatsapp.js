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
      console.log('WhatsApp client is ready!');
      if (this.callbacks.onReady) this.callbacks.onReady();
    });

    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.lastError = `Disconnected: ${reason}`;
      console.log('WhatsApp disconnected:', reason);
      if (this.callbacks.onDisconnect) this.callbacks.onDisconnect(reason);
    });

    this.client.on('message', (message) => this.handleMessage(message));

    await this.client.initialize();
  }

  async stop() {
    this.isRunning = false;
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

  async handleMessage(message) {
    try {
      if (!this.cfg.whatsapp || !this.cfg.whatsapp.enabled) return;

      let number = message.from;
      if (number && number.includes('@')) number = number.split('@')[0];

      const isSelfChat = message.fromMe && message.to && message.to === message.from;
      const allowSelf = this.cfg.whatsapp.allowSelfMessages !== false;

      if (message.fromMe && !(allowSelf && isSelfChat)) return;

      if (isSelfChat) {
        debug.log({ dir: 'self-test', number, body: debug.truncate(message.body, 200) });
      } else {
        if (message.isGroup) return;
        if (!this.isAllowedNumber(number)) return;
      }

      const text = (message.body || '').trim();
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
      const chat = await message.getChat();

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
            return message.reply(textMessage);
          }
        });
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  }
}

module.exports = WhatsAppBot;
