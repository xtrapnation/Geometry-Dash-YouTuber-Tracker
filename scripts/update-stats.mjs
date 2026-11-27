// Automatic stats updater for the GD YouTuber Tracker.
// Does the same thing as the site's "Fetch Stats" button, but headless, so it
// can run on a schedule (GitHub Actions). Only touches the stats fields of
// existing creators — never adds, removes or reorders creators, and leaves
// every other field exactly as stored.
//
// Env vars:
//   FIREBASE_SERVICE_ACCOUNT  service-account JSON (required unless DRY_RUN=1)
//   YT_API_KEY                YouTube Data API key (falls back to the site's key)
//   FS_PROJECT                Firestore project id   (default gd-yt-tracker)
//   FS_DOC                    document path           (default tracker/data)
//   BACKUP_PATH               where to write a JSON copy of the result (optional)
//   DRY_RUN=1                 fetch + compute, but don't write to Firestore

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = process.env.FS_PROJECT || 'gd-yt-tracker';
const DOC = process.env.FS_DOC || 'tracker/data';
const FS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${DOC}`;
const YT_KEY = process.env.YT_API_KEY || 'AIzaSyA_Q9m0UHUYJCKD3oKA666CS3kvCfWWa0Q';
const YT = 'https://www.googleapis.com/youtube/v3';
const DRY_RUN = process.env.DRY_RUN === '1';
const MIN_CREATORS = 50; // refuse to touch a doc that looks empty/corrupted

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Firestore value helpers ───────────────────────────────
function fromFs(v) {
  if (!v || 'nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromFs(x);
    return o;
  }
  return null;
}
const intVal = (n) => (n == null ? { nullValue: null } : { integerValue: String(n) });
const strVal = (s) => ({ stringValue: s ?? '' });

// ── Service-account auth (no dependencies) ────────────────
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Could not get access token: ' + JSON.stringify(j));
  return j.access_token;
}

// ── YouTube helpers ───────────────────────────────────────
function parseUrl(url) {
  if (!url) return null;
  const u = url.replace(/\/+$/, '');
  const mh = u.match(/youtube\.com\/@([^/?#]+)/);
  if (mh) {
    let h = mh[1];
    try { h = decodeURIComponent(h); } catch {}
    return { type: 'handle', raw: h };
  }
  const mc = u.match(/youtube\.com\/channel\/(UC[^/?#]+)/);
  if (mc) return { type: 'channelId', raw: mc[1] };
  return null;
}

async function ytGet(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) {
        const reason = j.error.errors?.[0]?.reason;
        if (reason === 'quotaExceeded') throw Object.assign(new Error('YouTube quota exceeded'), { fatal: true });
        throw new Error(j.error.message);
      }
      return j;
    } catch (e) {
      if (e.fatal || attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function resolveHandle(handle) {
  const j = await ytGet(`${YT}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${YT_KEY}`);
  return j.items?.[0]?.id || null;
}

async function fetchStats(ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const j = await ytGet(`${YT}/channels?part=statistics,snippet&id=${chunk.join(',')}&maxResults=50&key=${YT_KEY}`);
    for (const item of j.items || []) {
      const subs = parseInt(item.statistics?.subscriberCount);
      const views = parseInt(item.statistics?.viewCount);
      map[item.id] = {
        subscribers: isNaN(subs) ? null : subs,
        totalViews: isNaN(views) ? null : views,
        avatar: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
      };
    }
    await sleep(150);
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (!sa && !DRY_RUN) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const token = sa ? await getAccessToken(sa) : null;
  const authHeader = token ? { Authorization: 'Bearer ' + token } : {};

  // 1. Read the current document (raw Firestore format, so untouched fields round-trip exactly)
  const res = await fetch(FS_URL, { headers: authHeader });
  if (!res.ok) throw new Error(`Firestore read failed: HTTP ${res.status}`);
  const doc = await res.json();
  const rawCreators = doc.fields?.creators?.arrayValue?.values || [];
  if (rawCreators.length < MIN_CREATORS) {
    throw new Error(`Only ${rawCreators.length} creators in ${DOC} — refusing to write. Check the database.`);
  }
  console.log(`Read ${rawCreators.length} creators from ${DOC} (updateTime ${doc.updateTime})`);

  // 2. Work out every creator's channel id
  const entries = rawCreators.map((raw) => ({ raw, c: fromFs(raw) }));
  const toResolve = [];
  for (const e of entries) {
    if (e.c.channelId) { e.id = e.c.channelId; continue; }
    const p = parseUrl(e.c.url);
    if (!p) continue;
    if (p.type === 'channelId') e.id = p.raw;
    else toResolve.push(e), (e.handle = p.raw);
  }
  console.log(`${entries.length - toResolve.length} have a cached channel id, resolving ${toResolve.length} @handles…`);
  for (let i = 0; i < toResolve.length; i += 10) {
    await Promise.all(toResolve.slice(i, i + 10).map(async (e) => {
      try { e.id = await resolveHandle(e.handle); } catch (err) { if (err.fatal) throw err; }
    }));
    await sleep(150);
  }

  // 3. Fetch stats in batches of 50
  const ids = [...new Set(entries.filter((e) => e.id).map((e) => e.id))];
  const stats = await fetchStats(ids);

  // 4. Apply — same growth logic as the site's Fetch Stats button
  const now = Date.now();
  let updated = 0, unchanged = 0;
  const failed = [];
  for (const e of entries) {
    const s = e.id && stats[e.id];
    if (!s) { failed.push(e.c.name); continue; }
    const c = e.c;
    const f = e.raw.mapValue.fields;
    const sChg = s.subscribers != null && c.subscribers != null && c.subscribers !== s.subscribers;
    const vChg = s.totalViews != null && c.totalViews != null && c.totalViews !== s.totalViews;
    if (sChg || vChg) {
      if (sChg) f.prevSubscribers = intVal(c.subscribers);
      if (vChg) f.prevTotalViews = intVal(c.totalViews);
      f.prevFetchedAt = intVal(c.fetchedAt ?? null);
      updated++;
    } else unchanged++;
    if (s.subscribers != null) f.subscribers = intVal(s.subscribers);
    if (s.totalViews != null) f.totalViews = intVal(s.totalViews);
    if (s.avatar) f.avatar = strVal(s.avatar);
    f.channelId = strVal(e.id);
    f.fetchedAt = intVal(now);
  }
  console.log(`Stats changed for ${updated}, unchanged ${unchanged}, not found ${failed.length}`);
  if (failed.length) console.log('Not found:', failed.join(', '));
  if (failed.length > entries.length / 2) {
    throw new Error('More than half the channels failed — not writing, something is wrong (quota? API key?).');
  }

  const updatedAt = new Date().toISOString();

  // 5. Backup copy (plain JSON) — committed to the repo by the workflow
  if (process.env.BACKUP_PATH) {
    fs.mkdirSync(path.dirname(process.env.BACKUP_PATH), { recursive: true });
    fs.writeFileSync(process.env.BACKUP_PATH, JSON.stringify({
      updatedAt,
      creators: entries.map((e) => fromFs(e.raw)),
    }, null, 2) + '\n');
    console.log('Wrote backup to', process.env.BACKUP_PATH);
  }

  if (DRY_RUN) { console.log('DRY_RUN=1 — not writing to Firestore.'); return; }

  // 6. Write back. updateMask = only these two fields; the updateTime precondition
  //    makes the write fail (instead of overwriting) if someone saved from the site mid-run.
  const qs = new URLSearchParams();
  qs.append('updateMask.fieldPaths', 'creators');
  qs.append('updateMask.fieldPaths', 'updatedAt');
  qs.append('currentDocument.updateTime', doc.updateTime);
  const w = await fetch(`${FS_URL}?${qs}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        creators: { arrayValue: { values: entries.map((e) => e.raw) } },
        updatedAt: { timestampValue: updatedAt },
      },
    }),
  });
  if (!w.ok) throw new Error(`Firestore write failed: HTTP ${w.status} ${await w.text()}`);
  console.log(`Saved ${entries.length} creators to ${DOC} at ${updatedAt}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
