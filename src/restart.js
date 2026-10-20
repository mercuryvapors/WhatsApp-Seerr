'use strict';

const fs = require('fs');
const debug = require('./debug');
const docker = require('./docker');

const TICK_MS = 30 * 1000;
const DEFAULT_TIME = '04:00';
const VALID_MODES = ['auto', 'container', 'bot', 'refresh'];

/**
 * Parse an "HH:MM" string into a 24h clock time.
 * @param {*} value
 * @returns {{hour: number, minute: number}|null}
 */
function parseTime(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

/**
 * Next time the given wall-clock time occurs, strictly in the future.
 * Never catches up on a missed slot, so a container that boots after the
 * scheduled time does not immediately restart itself in a loop.
 */
function nextOccurrence(hour, minute, from) {
  const base = from instanceof Date ? from : new Date();
  const target = new Date(base.getTime());
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= base.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function isContainer() {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch (e) {
    return false;
  }
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Schedules a daily restart of the bridge.
 *
 * Modes:
 *  - 'container': restart the container through the Docker API. When the Docker
 *    socket is not mounted, fall back to exiting the process and rely on the
 *    container's restart policy.
 *  - 'refresh':   rebuild the app in place — the container keeps running, the
 *    web UI and Seerr connection stay up, only the WhatsApp client is redone.
 *  - 'bot':       keep the process alive and only re-create the WhatsApp client.
 *  - 'auto':      'container' when running in Docker, otherwise 'refresh'.
 */
class AutoRestarter {
  constructor(opts = {}) {
    this.getConfig = opts.getConfig || (() => ({}));
    this.onRestart = opts.onRestart || (async () => {});
    this.onContainerRestart = opts.onContainerRestart || (async () => {});
    this.interval = null;
    this.next = null;
    this.lastRestart = null;
    this.lastError = null;
    this.container = null; // cached Docker container info
  }

  settings() {
    let cfg = {};
    try {
      cfg = this.getConfig() || {};
    } catch (e) {
      cfg = {};
    }
    const ar = (cfg.server && cfg.server.autoRestart) || {};
    const time = typeof ar.time === 'string' && ar.time.trim() ? ar.time.trim() : DEFAULT_TIME;
    const rawMode = VALID_MODES.includes(ar.mode) ? ar.mode : 'auto';
    return {
      enabled: !!ar.enabled,
      time,
      mode: rawMode,
      resolvedMode: rawMode === 'auto' ? (isContainer() ? 'container' : 'refresh') : rawMode
    };
  }

  start() {
    this.stop();
    this.interval = setInterval(() => this.tick(), TICK_MS);
    if (this.interval.unref) this.interval.unref();
    this.apply();
    // Look up the container in the background so the UI can show the policy.
    this.refreshContainerInfo();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Recompute the next scheduled restart (called on boot and on config save). */
  apply() {
    const s = this.settings();
    if (!s.enabled) {
      this.next = null;
      this.lastError = null;
      return;
    }
    const parsed = parseTime(s.time);
    if (!parsed) {
      this.next = null;
      this.lastError = `Invalid restart time "${s.time}" (expected HH:MM)`;
      debug.log({ dir: 'system', event: 'auto-restart', detail: this.lastError });
      return;
    }
    this.lastError = null;
    this.next = nextOccurrence(parsed.hour, parsed.minute, new Date());
    debug.log({
      dir: 'system',
      event: 'auto-restart',
      detail: `scheduled for ${this.next.toISOString()} (${s.time} ${localTimezone()}, mode=${s.resolvedMode})`
    });
  }

  async refreshContainerInfo() {
    try {
      this.container = await docker.detectContainer();
    } catch (e) {
      this.container = { available: false, reason: e.message };
    }
    return this.container;
  }

  tick() {
    // Refresh the container/policy info occasionally so the UI stays current.
    this._ticks = (this._ticks || 0) + 1;
    if (this._ticks % 10 === 0) this.refreshContainerInfo();

    if (!this.next) return;
    if (Date.now() < this.next.getTime()) return;
    this.next = null;
    this.trigger('scheduled');
  }

  /**
   * Perform the restart.
   *
   * In 'container' mode we ask the Docker daemon to restart the container
   * directly. That is reliable regardless of the restart policy and it also
   * works when the container is not managed by a policy at all. If the socket
   * is unavailable we fall back to an in-place refresh, and only exit the
   * process when a restart policy is actually going to bring it back.
   */
  async trigger(reason) {
    const s = this.settings();
    this.lastRestart = new Date().toISOString();
    debug.log({ dir: 'system', event: 'auto-restart', detail: `restart (${reason}) mode=${s.resolvedMode}` });
    console.log(`[restart] ${reason} restart requested (mode: ${s.resolvedMode})`);

    if (s.resolvedMode === 'container') {
      try {
        await this.onContainerRestart(reason, s);
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`[restart] Docker API restart failed: ${msg}`);
        debug.log({ dir: 'system', event: 'auto-restart-error', detail: `docker restart failed: ${msg}` });
        this.lastError = msg;
        // Fall through to the fallback below.
      }
    }

    try {
      await this.onRestart(reason, s);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('[restart] failed:', msg);
      debug.log({ dir: 'system', event: 'auto-restart-error', detail: msg });
      this.apply();
      // apply() clears lastError for a valid schedule, so set it afterwards
      this.lastError = msg;
    }
  }

  status() {
    const s = this.settings();
    const c = this.container || {};
    return {
      enabled: s.enabled,
      time: s.time,
      mode: s.mode,
      resolvedMode: s.resolvedMode,
      timezone: localTimezone(),
      nextRestart: this.next ? this.next.toISOString() : null,
      lastRestart: this.lastRestart,
      error: this.lastError,
      inContainer: isContainer(),
      docker: {
        socket: docker.hasSocket(),
        container: c.name || null,
        restartPolicy: c.restartPolicy || null,
        reason: c.reason || ''
      }
    };
  }
}

module.exports = {
  AutoRestarter,
  parseTime,
  nextOccurrence,
  isContainer,
  localTimezone,
  DEFAULT_TIME,
  TICK_MS
};
