const fs = require('fs');
const path = require('path');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveDataDir() {
  const envDir = process.env.DATA_DIR ? String(process.env.DATA_DIR).trim() : '';
  const candidates = [];
  if (envDir) candidates.push(envDir);
  candidates.push(path.join(__dirname, '..', 'data'));

  for (const dir of candidates) {
    if (!dir) continue;
    if (isWritable(dir)) {
      if (dir !== envDir && envDir) {
        console.warn(`[config] DATA_DIR "${envDir}" is not writable; using "${dir}" instead.`);
        console.warn('[config] Check the container volume mapping (e.g. /mnt/user/appdata/whatsapp-seerr:/data) and permissions.');
      }
      return dir;
    }
    console.warn(`[config] Data directory not usable: "${dir}"`);
  }
  throw new Error('No writable data directory found. Set DATA_DIR to a writable path.');
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  server: {
    port: 7000
  },
  whatsapp: {
    enabled: false,
    sessionFile: path.join(DATA_DIR, 'wa-session'),
    allowedNumbers: [],
    commandPrefix: '!',
    allowSelfMessages: true
  },
  seerr: {
    url: '',
    apiKey: '',
    impersonate: {
      email: '',
      password: ''
    },
    users: [],
    type: 'overseerr',
    enabled: false
  },
  app: {
    name: 'WhatsApp Seerr Bridge'
  }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.whatsapp.sessionFile = path.join(DATA_DIR, 'wa-session');
  return cfg;
}

function loadConfig() {
  ensureDataDir();
  let cfg;
  if (!fs.existsSync(CONFIG_FILE)) {
    cfg = defaultConfig();
    saveConfig(cfg);
  } else {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = deepMerge(defaultConfig(), parsed);
    } catch (e) {
      console.error('Failed to parse config, using defaults:', e.message);
      cfg = defaultConfig();
    }
  }
  applyEnvOverrides(cfg);
  return cfg;
}

function applyEnvOverrides(cfg) {
  const email = String(process.env.SEERR_IMPERSONATE_EMAIL || '').trim();
  const password = String(process.env.SEERR_IMPERSONATE_PASSWORD || '');
  if (email) cfg.seerr.impersonate.email = email;
  if (password) cfg.seerr.impersonate.password = password;
  if (email || password) {
    console.log(`[config] Seerr impersonation overridden by environment (email: ${email || 'unset'})`);
  }
}

function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function deepMerge(base, override) {
  const result = JSON.parse(JSON.stringify(base));
  if (!override || typeof override !== 'object') return result;
  for (const key of Object.keys(override)) {
    if (
      override[key] &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = { loadConfig, saveConfig, defaultConfig, DATA_DIR, CONFIG_FILE };