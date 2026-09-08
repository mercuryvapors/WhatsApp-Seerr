'use strict';

const MAX_ENTRIES = 300;
let entries = [];
let nextId = 1;

function truncate(str, max = 400) {
  if (str == null) return '';
  let s = typeof str === 'string' ? str : JSON.stringify(str);
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

function log(entry) {
  if (!entry || typeof entry !== 'object') return;
  entries.push({
    id: nextId++,
    ts: new Date().toISOString(),
    ...entry
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

function all() {
  return entries.slice();
}

function clear() {
  entries = [];
  return entries.length;
}

module.exports = { log, all, clear, truncate };