'use strict';

const fs = require('fs');
const http = require('http');
const debug = require('./debug');

const SOCKET_CANDIDATES = ['/var/run/docker.sock', '/run/docker.sock', '/var/run/docker.sock.raw'];
const DOCKER_API_VERSION = 'v1.41';

/**
 * Path to the Docker daemon socket, if one is mounted into this container.
 * @returns {string|null}
 */
function socketPath() {
  const host = process.env.DOCKER_HOST || '';
  if (host.startsWith('unix://')) {
    const p = host.slice('unix://'.length);
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      /* ignore */
    }
    return null;
  }
  for (const p of SOCKET_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

function hasSocket() {
  return !!socketPath();
}

/**
 * Minimal Docker Engine API call over the unix socket.
 */
function request(method, path, body) {
  const sock = socketPath();
  if (!sock) return Promise.reject(new Error('Docker socket not mounted'));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: sock,
        method,
        path: `/${DOCKER_API_VERSION}${path}`,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!out) return resolve({});
            try {
              resolve(JSON.parse(out));
            } catch (e) {
              resolve({ raw: out });
            }
          } else {
            reject(new Error(`Docker API ${res.statusCode}: ${out.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Docker API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The host PID of a process, read from the NSpid line in /proc/<pid>/status.
 * The first value is the PID in the outermost namespace.
 */
function nspidHostPid(pid, readFile) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  try {
    const status = read(`/proc/${pid}/status`);
    const m = /^NSpid:\s+(.+)$/m.exec(status);
    if (m) {
      const parts = m[1].trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (parts.length && parts[0]) return parts[0];
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

/** Host PID of this process. */
function hostPid(readFile) {
  return nspidHostPid('self', readFile);
}

/** Host PID of the container's init process — what Docker reports as State.Pid. */
function initHostPid(readFile) {
  return nspidHostPid('1', readFile);
}

/**
 * Best-effort detection of this container's id.
 *
 * Docker leaks the full id in different places depending on the cgroup
 * version and runtime:
 *  - /proc/self/mountinfo references /var/lib/docker/containers/<id>/... for
 *    the bind-mounted /etc/hostname and friends.
 *  - /proc/self/cgroup contains it under cgroup v1.
 *  - the hostname defaults to the short container id.
 */
function detectContainerId(readFile) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));

  const override = String(process.env.DOCKER_CONTAINER_ID || '').trim();
  if (override) return override;

  try {
    const mi = read('/proc/self/mountinfo');
    const m = /\/containers\/([0-9a-f]{64})(?:\/|\s|$)/m.exec(mi);
    if (m) return m[1];
  } catch (e) {
    /* ignore */
  }

  try {
    const cgroup = read('/proc/self/cgroup');
    const m = /([0-9a-f]{64})/.exec(cgroup);
    if (m) return m[1];
  } catch (e) {
    /* ignore */
  }

  try {
    const h = read('/etc/hostname').trim();
    if (/^[0-9a-f]{12,64}$/.test(h)) return h;
  } catch (e) {
    /* ignore */
  }

  return null;
}

/**
 * Ask the Docker daemon about a container.
 * @param {string} idOrName
 */
async function inspect(idOrName) {
  const info = await request('GET', `/containers/${encodeURIComponent(idOrName)}/json`);
  return {
    id: info.Id,
    name: String(info.Name || '').replace(/^\//, ''),
    image: info.Config && info.Config.Image,
    status: info.State && info.State.Status,
    startedAt: info.State && info.State.StartedAt,
    pid: info.State && info.State.Pid,
    restartPolicy:
      (info.HostConfig && info.HostConfig.RestartPolicy && info.HostConfig.RestartPolicy.Name) || 'no'
  };
}

/**
 * Resolve which container we are, and what its restart policy is.
 * @returns {Promise<{available: boolean, id: string|null, name: string|null, restartPolicy: string|null, reason: string}>}
 */
async function detectContainer() {
  if (!hasSocket()) {
    return {
      available: false,
      id: null,
      name: null,
      restartPolicy: null,
      reason: 'Docker socket not mounted'
    };
  }

  const candidates = [];
  const detected = detectContainerId();
  if (detected) candidates.push(detected);
  const nameOverride = String(process.env.DOCKER_CONTAINER_NAME || '').trim();
  if (nameOverride) candidates.push(nameOverride);

  for (const c of candidates) {
    try {
      const info = await inspect(c);
      return {
        available: true,
        id: info.id,
        name: info.name,
        restartPolicy: info.restartPolicy,
        status: info.status,
        reason: ''
      };
    } catch (e) {
      /* try the next candidate */
    }
  }

  // Fall back to matching the daemon's container list against our host PID.
  // The daemon reports State.Pid for the container's init process, so compare
  // against PID 1 in our namespace.
  const pid = initHostPid();
  if (pid) {
    try {
      const list = await request('GET', '/containers/json?all=1');
      const match = (Array.isArray(list) ? list : []).find((c) => c && c.State && c.State.Pid === pid);
      if (match) {
        const info = await inspect(match.Id);
        return {
          available: true,
          id: info.id,
          name: info.name,
          restartPolicy: info.restartPolicy,
          status: info.status,
          reason: ''
        };
      }
    } catch (e) {
      /* fall through */
    }
  }

  return {
    available: true,
    id: null,
    name: null,
    restartPolicy: null,
    reason: 'Could not identify this container'
  };
}

/**
 * Restart this container through the Docker API. This works regardless of the
 * container's restart policy — the daemon explicitly stops and starts it.
 *
 * The daemon tears down our own process while it handles the request, so the
 * HTTP connection is usually reset before a response arrives. That is a
 * successful restart, not a failure, so it is reported as such.
 */
async function restartContainer(timeoutSec = 30) {
  const info = await detectContainer();
  if (!info.available) throw new Error(info.reason || 'Docker API unavailable');
  if (!info.id) throw new Error(info.reason || 'Could not identify this container');

  debug.log({
    dir: 'system',
    event: 'docker-restart',
    detail: `restarting container ${info.name} (${String(info.id).slice(0, 12)})`
  });

  try {
    await request('POST', `/containers/${encodeURIComponent(info.id)}/restart?t=${timeoutSec}`);
  } catch (e) {
    const code = e && e.code;
    const msg = e && e.message ? e.message : String(e);
    const expected = ['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code) || /socket hang up|aborted/i.test(msg);
    if (!expected) throw e;
    debug.log({
      dir: 'system',
      event: 'docker-restart',
      detail: 'connection dropped during restart (expected — the container is being restarted)'
    });
  }
  return info;
}

module.exports = {
  socketPath,
  hasSocket,
  detectContainer,
  detectContainerId,
  initHostPid,
  hostPid,
  inspect,
  restartContainer
};
