const express = require('express');
const path = require('path');
const { loadConfig, saveConfig, DATA_DIR } = require('./config');
const WhatsAppBot = require('./whatsapp');
const SeerrApi = require('./seerr');
const debug = require('./debug');

const app = express();
app.use(express.json());

let config = loadConfig();
const bot = new WhatsAppBot(config, {
  onCommand: handleCommand,
  onQr: () => {},
  onReady: () => {},
  onDisconnect: () => {}
});

const seerr = new SeerrApi(config);

function handleCommand({ cmd, args, reply, number }) {
  const prefix = config.whatsapp.commandPrefix || '!';
  debug.log({
    dir: 'system',
    event: 'command-entry',
    detail: debug.truncate({
      cmd,
      args,
      waEnabled: !!(config.whatsapp && config.whatsapp.enabled),
      seerrEnabled: seerr.isEnabled(),
      seerrUrl: seerr.settings().url
    })
  });
  const run = (fn, label) => {
    try {
      return Promise.resolve(fn()).then(
        (r) => {
          debug.log({ dir: 'system', event: 'command-ok', detail: label });
          return r;
        },
        (e) => {
          console.error(`Command "${cmd}" (${label}) failed:`, e);
          debug.log({ dir: 'system', event: 'command-error', detail: `${label}: ${e && e.message}` });
          return reply(`❌ Command failed (${label}): ${e && e.message}`);
        }
      );
    } catch (e) {
      console.error(`Command "${cmd}" (${label}) threw synchronously:`, e);
      debug.log({ dir: 'system', event: 'command-error', detail: `${label}: ${e && e.message}` });
      return reply(`❌ Command failed (${label}): ${e && e.message}`);
    }
  };
  switch (cmd) {
    case 'help':
      return run(() => reply(
        `*${config.app.name || 'WhatsApp Seerr Bridge'}*\n\n` +
          `Available commands:\n` +
          `${prefix}request <title> - Request media (movie)\n` +
          `${prefix}request tv <title> - Request a TV show\n` +
          `${prefix}request movie <title> - Request a movie\n` +
          `${prefix}test - Run a connection diagnostic\n` +
          `${prefix}help - Show this message`
      ), 'help');
    case 'request':
      return run(() => handleRequest(args, reply), 'request');
    case 'test':
      return run(() => handleChatTest(reply), 'test');
    default:
      return run(() => reply(`Unknown command. Type ${prefix}help for available commands.`), 'default');
  }
}

async function handleChatTest(reply) {
  const lines = ['*Diagnostics*', ''];
  const wa = bot.getStatus();
  lines.push(
    `WhatsApp: ${wa.status === 'ready' ? '✅ connected' : '⚠️ ' + (wa.status || 'not connected')}`
  );

  if (!seerr.isConfigured()) {
    lines.push('Seerr: ❌ not configured (missing URL or API key) — open the web UI.');
  } else if (!config.seerr.enabled) {
    lines.push('Seerr: ⚠️ configured but disabled in the web UI.');
  } else {
    try {
      const result = await seerr.test();
      const reach = result.checks.find((c) => c.name === 'Seerr reachable') || {};
      const auth = result.checks.find((c) => c.name === 'API key valid' || c.name === 'User login valid') || {};
      lines.push(`Seerr URL: ${reach.ok ? '✅ reachable — ' + (reach.detail || '') : '❌ ' + (reach.detail || 'no URL')}`);
      lines.push(`${auth.name || 'Auth'}: ${auth.ok ? '✅ ' + (auth.detail || 'valid') : '❌ ' + (auth.detail || 'invalid')}`);
    } catch (e) {
      lines.push('Seerr test failed: ' + e.message);
    }
  }

  lines.push('', 'Open the web UI for full diagnostics.');
  return reply(lines.join('\n'));
}

async function handleRequest(args, reply) {
  if (!seerr.isEnabled()) {
    return reply('Seerr is not configured or disabled. Please check the web UI.');
  }
  if (!args) {
    return reply('Please provide a title. Example: !request Dune');
  }

  const lower = args.toLowerCase();
  let mediaType = null;
  let title = args;
  if (lower.startsWith('movie')) {
    mediaType = 'movie';
    title = args.replace(/^movie\b/i, '').trim();
  } else if (lower.startsWith('tv') || lower.startsWith('show') || lower.startsWith('series')) {
    mediaType = 'tv';
    title = args.replace(/^(tv|show|series)\b/i, '').trim();
  }
  title = title.replace(/^["']+|["']+$/g, '').trim();
  if (!title) {
    return reply('Please provide a title. Example: !request Dune');
  }

  try {
    await (mediaType === 'tv' ? seerr.requestTv(title) : seerr.requestMovie(title));
    return reply(`✅ Requested "*${title}*" successfully!`);
  } catch (e) {
    return reply(`❌ Failed to request "${title}": ${e.message}`);
  }
}

function applyConfig(newConfig) {
  config = newConfig;
  try {
    saveConfig(config);
    debug.log({
      dir: 'system',
      event: 'config-saved',
      detail: debug.truncate({
        waEnabled: config.whatsapp.enabled,
        seerrEnabled: config.seerr.enabled,
        seerrUrl: config.seerr.url
      })
    });
  } catch (e) {
    debug.log({
      dir: 'system',
      event: 'config-save-failed',
      detail: e.message
    });
    console.error('Failed to save config:', e.message);
  }
  seerr.config = config;
  bot.cfg = config;

  const shouldRun = config.whatsapp && config.whatsapp.enabled;
  if (shouldRun && bot.getStatus().status !== 'ready' && !bot.isRunning) {
    bot.start();
  } else if (!shouldRun && bot.isRunning) {
    bot.stop();
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    ...config,
    whatsapp: {
      ...config.whatsapp,
      allowedNumbers: config.whatsapp.allowedNumbers || []
    }
  });
});

app.post('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    if (body.whatsapp && Array.isArray(body.whatsapp.allowedNumbers)) {
      body.whatsapp.allowedNumbers = body.whatsapp.allowedNumbers
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n));
    }
    const merged = {
      ...config,
      ...body,
      whatsapp: { ...config.whatsapp, ...(body.whatsapp || {}) },
      seerr: {
        ...config.seerr,
        ...(body.seerr || {}),
        impersonate: {
          ...(config.seerr.impersonate || {}),
          ...((body.seerr && body.seerr.impersonate) || {})
        }
      },
      server: { ...config.server, ...(body.server || {}) },
      app: { ...config.app, ...(body.app || {}) }
    };
    applyConfig(merged);
    res.json({ success: true, config: merged });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    version: require('../package.json').version,
    gitSha: (process.env.GIT_SHA || 'dev').slice(0, 7),
    whatsapp: bot.getStatus(),
    seerr: {
      enabled: seerr.isEnabled(),
      configured: seerr.isConfigured(),
      impersonating: seerr._userEmail || false,
      impersonateConfigured: seerr.hasImpersonation()
    }
  });
});

app.post('/api/test/seerr', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await seerr.test(body);
    res.json({ success: result.ok, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/debug/logs', (req, res) => {
  res.json(debug.all());
});

app.post('/api/debug/clear', (req, res) => {
  debug.clear();
  res.json({ success: true });
});

app.post('/api/whatsapp/start', (req, res) => {
  config.whatsapp.enabled = true;
  saveConfig(config);
  bot.cfg = config;
  bot
    .start()
    .then(() => {
      let status = bot.getStatus();
      setTimeout(() => {
        status = bot.getStatus();
        res.json({ success: true, status });
      }, 300);
    })
    .catch((e) => res.status(500).json({ success: false, error: e.message }));
});

app.post('/api/whatsapp/stop', (req, res) => {
  config.whatsapp.enabled = false;
  saveConfig(config);
  bot
    .stop()
    .then(() => res.json({ success: true, status: bot.getStatus() }))
    .catch((e) => res.status(500).json({ success: false, error: e.message }));
});

app.get('/api/whatsapp/qr', (req, res) => {
  res.json({ qr: bot.getStatus().qr || null });
});

app.get('/api/whatsapp/qr.png', async (req, res) => {
  const qr = bot.getStatus().qr;
  if (!qr) return res.status(404).json({ error: 'No QR available' });
  try {
    const qrcode = require('qrcode');
    const dataUrl = await qrcode.toDataURL(qr, { width: 260, margin: 1 });
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || config.server.port || 7000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`${config.app.name || 'WhatsApp Seerr Bridge'} running on port ${port}`);
    debug.log({
      dir: 'system',
      event: 'server-started',
      detail: debug.truncate({
        version: require('../package.json').version,
        gitSha: (process.env.GIT_SHA || 'dev').slice(0, 7),
        dataDir: DATA_DIR,
        waEnabled: config.whatsapp && config.whatsapp.enabled,
        seerrUrl: config.seerr && config.seerr.url
      })
    });
    if (config.whatsapp && config.whatsapp.enabled) {
      bot.start();
    }
    if (config.seerr && !config.seerr.url) {
      console.log('Seerr is not configured. Open the web UI to configure it.');
    }
  });
}

module.exports = { app, config: () => config, applyConfig, handleCommand, bot, seerr, debug };
