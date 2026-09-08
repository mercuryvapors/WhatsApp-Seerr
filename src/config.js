const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = deepMerge(defaultConfig(), parsed);
    return merged;
  } catch (e) {
    console.error('Failed to parse config, using defaults:', e.message);
    return defaultConfig();
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

module.exports = { loadConfig, saveConfig, defaultConfig };
