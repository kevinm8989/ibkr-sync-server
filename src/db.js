/**
 * Lightweight file-based key-value store.
 * Persists to /data/db.json — on Railway, mount a Volume at /data for persistence.
 * Falls back to in-memory if filesystem is read-only.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'db.json');

let store = {};

// Load existing data
try {
  if (fs.existsSync(DB_PATH)) {
    store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    console.log(`[db] Loaded ${Object.keys(store).length} keys from ${DB_PATH}`);
  } else {
    console.log(`[db] No existing DB found, starting fresh.`);
  }
} catch (err) {
  console.warn(`[db] Could not read DB file: ${err.message}. Using in-memory store.`);
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn(`[db] Could not persist DB: ${err.message}`);
  }
}

export const db = {
  get: (key) => store[key],
  set: (key, value) => {
    store[key] = value;
    persist();
  },
  delete: (key) => {
    delete store[key];
    persist();
  }
};
