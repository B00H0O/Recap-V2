// pool-server.mjs (v2) - MULTI-TARGET. Rotating FRESH-PROFILE FLEET per (sitekey,target).
//   GET /token?sitekey=6L..&target=https://site[&enterprise=1]  ->  { elapsed, token }
//
// Model (clear naming - not "slot/pool"):
//   - Browser = one real Chrome process + a FRESH temp profile (the identity/recycle unit).
//   - Tab     = a V2Session (its own widget) inside a browser (TABS_PER_BROWSER of them, scoped OOPIF routing).
//   - Fleet   = the set of browsers serving one (sitekey,target). Concurrency = browsers x tabs.
// Each tab solves via WARM-REUSE (solveOnce()+reset()); background re-arm hides the ~1s reset. An STT MISS just
// resets that tab + retries; only an AUDIO BLOCK recycles the whole browser (fresh profile dodges per-profile block).
// HEADLESS=1 = true headless ; HEADLESS=0 = visible window. Linux: --no-sandbox + headless, or xvfb. STT via the vosk/whispercpp/deepgram worker.
//
// Hardened: retry-on-another-tab/browser, watchdog (auto-recycle dead Chrome), recycle-retry w/ backoff, token
// validation, /stats, validated config. Internals exported; listen()/watchdog only start when run directly.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp.mjs';
import { V2Session } from './solve-v2.mjs';
import * as tui from './tui.mjs';

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
function numEnv(name, def, { min = 0, max = Infinity } = {}) {
  const names = Array.isArray(name) ? name : [name];        // accept [newClearName, ...oldAliases] - first one set wins (backward-compat rename)
  let raw, hit = names[0];
  for (const n of names) { if (process.env[n] !== undefined && process.env[n] !== '') { raw = process.env[n]; hit = n; break; } }
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) { console.error(`${ts()} [config] invalid ${hit}="${raw}" (need ${min}..${max}) - using ${def}`); return def; }
  return v;
}
// --- .env loader: KEY=VALUE from ./.env (or ../.env); only fills vars NOT already in the environment ---
function loadDotenv() {
  for (const f of [path.join(process.cwd(), '.env'), path.join(process.cwd(), '..', '.env')]) {
    try { const txt = fs.readFileSync(f, 'utf8'); for (const line of txt.split(/\r?\n/)) { if (/^\s*#/.test(line)) continue; const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) { let v = m[2]; v = /^["']/.test(v) ? v.replace(/^["']|["']$/g, '') : v.replace(/\s+#.*$/, '').trim(); process.env[m[1]] = v; } } return; } catch {} // strip inline "# comment" on unquoted values (else `TABS=1 # note` -> NaN -> default)
  }
}
loadDotenv();
const PROXY_MODE = /^(on|1|true|yes)$/i.test(process.env.USE_PROXIES || process.env.PROXY_MODE || ''); // toggle proxies on/off (clear name USE_PROXIES; old PROXY_MODE still works)
const PORT = numEnv('PORT', 4400, { min: 1, max: 65535 });
const BROWSERS_PER_FLEET = numEnv(['BROWSERS', 'BROWSERS_PER_FLEET'], 3, { min: 1 });   // how many real Chrome browsers to run = your concurrency (rule of thumb: ~ vCPU count)
const TABS_PER_BROWSER = numEnv(['TABS', 'TABS_PER_BROWSER'], PROXY_MODE ? 1 : 2, { min: 1 }); // tabs per browser. proxies -> 1 (more browsers = more IPs); no-proxy -> 2 (single-IP sweet spot). 3+ shares one Chrome's socket -> craters
const MAX_BROWSERS = numEnv(['MAX_BROWSERS'], 12, { min: 1 });              // global ceiling on total Chromes (usually set = BROWSERS)
const SOLVES_PER_BROWSER = numEnv(['RECYCLE_AFTER_SOLVES', 'SOLVES_PER_BROWSER'], PROXY_MODE ? 12 : 6, { min: 1 }); // fresh profile (+ new proxy) after this many solves. proxies -> 12; no-proxy -> 6 (single-IP audio hardens after ~5-10)
const RETRIES = numEnv('RETRIES', 3, { min: 1 });                         // attempts across tabs/browsers per /token
const FAIL_RECYCLE = numEnv('FAIL_RECYCLE', 3, { min: 1 });               // recycle a browser (fresh profile+proxy) after this many CONSECUTIVE solve failures (rotates away from a slow/soft-blocked exit)
const TOKEN_DEADLINE = numEnv('TOKEN_DEADLINE', 40000, { min: 5000 });    // hard wall-clock cap on one /token (incl. acquire wait + retries) so a pathological pool (e.g. ALL proxies dead) fails fast instead of hanging; > worst legit solve (~32s = 4 audio tries on a slow exit)
const RECYCLE_RETRIES = numEnv('RECYCLE_RETRIES', 4, { min: 1 });
const WATCHDOG_MS = numEnv('WATCHDOG_MS', 5000, { min: 0 });
const ROLLING = process.env.ROLLING !== '0';                              // rolling replacement (default ON): pre-launch a fresh browser before retiring a burned one (free frequent recycling; MEASURED: sustains 162 vs 98 CPM). ROLLING=0 to disable.
const VIEWPORT_W = numEnv('VIEWPORT_W', 1024, { min: 1 }), VIEWPORT_H = numEnv('VIEWPORT_H', 768, { min: 1 });
const HEADLESS = process.env.HEADLESS === '1';            // HEADLESS=1 hidden | HEADLESS=0 visible window (no off-screen mode - headless works for v2/v3)
const EXTRA_FLAGS = process.env.EXTRA_FLAGS || ''; // extra Chrome flags (e.g. --blink-settings=imagesEnabled=false to skip image tiles)
const DEBUG = process.env.DEBUG === '1' || process.argv.includes('debug'); // verbose per-request pipeline (RECV->ACQUIRE->SOLVE->TOKEN->SEND)
let DBG_ID = 0;                                           // current request id (set at RECV) so solve-v2's debug SOLVE steps share the right #id
const PER_TAB_PROXY = process.env.PER_TAB_PROXY === '1'; // each TAB gets its own proxy via a browser context (own egress IP per tab, Kasada-style) instead of one proxy per browser - decouples #IPs from #Chromes (v2-only; contexts score ~0.2 on v3)
const UA = process.env.UA || `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36`;
const CACHE_DIR = process.env.DISK_CACHE || path.join(os.tmpdir(), 'rev2-shared-cache');

// IP ROTATION: per-browser proxy from a rotating PROXIES list - rotate egress IP to keep v2 audio easy/fast (a worked
// IP soft-degrades). Entries: host:port | user:pass@host:port | scheme://user:pass@host:port | host:port:user:pass
export function parseProxies(s) {
  return (s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).map((p) => {
    let m;
    if ((m = p.match(/^(?:(\w+):\/\/)?(?:([^:@\s]+):([^@\s]+)@)?([^:@\s]+):(\d+)$/))) return { server: `${m[1] || 'http'}://${m[4]}:${m[5]}`, username: m[2], password: m[3] };
    if ((m = p.match(/^([^:\s]+):(\d+):([^:\s]+):([^\s]+)$/))) return { server: `http://${m[1]}:${m[2]}`, username: m[3], password: m[4] };
    return null;
  }).filter(Boolean);
}
// proxies load ONLY when PROXY_MODE=on: from PROXIES env, else proxies.txt (CWD then parent). Verified-working list.
function loadProxies() {
  if (!PROXY_MODE) return [];
  let raw = process.env.PROXIES || '';
  if (!raw.trim()) {
    const pf = process.env.PROXIES_FILE || 'proxies.txt';
    // absolute PROXIES_FILE must be used as-is (path.join would glue it onto cwd)
    const cands = path.isAbsolute(pf) ? [pf] : [path.join(process.cwd(), pf), path.join(process.cwd(), '..', pf)];
    for (const f of cands) { try { const t = fs.readFileSync(f, 'utf8'); if (t.trim()) { raw = t; break; } } catch {} }
  }
  return parseProxies(raw);
}
const PROXIES = loadProxies();
let proxyIdx = 0;
const proxyFails = new Map();                              // proxy.server -> consecutive LAUNCH-fail count
const proxyCooldown = new Map();                           // proxy.server -> ts until which it's skipped (RECOVERABLE - a transient outage self-heals; NO permanent pool collapse)
const PROXY_DEAD_AFTER = +(process.env.PROXY_DEAD_AFTER || 2); // cool a proxy after this many LAUNCH failures
const PROXY_COOLDOWN_MS = +(process.env.PROXY_COOLDOWN_MS || 120000); // ...for this long, then retry it. Was a PERMANENT blacklist -> under stress every exit got blacklisted -> "all proxies dead" death-spiral (2164 fail-fasts/3%). Cooldown self-heals.
export function pickProxy() {                              // round-robin, skipping exits currently in cooldown
  if (!PROXIES.length) return null;
  const now = Date.now();
  for (let i = 0; i < PROXIES.length; i++) { const p = PROXIES[proxyIdx++ % PROXIES.length]; if ((proxyCooldown.get(p.server) || 0) <= now) return p; }
  return null;                                             // ALL in cooldown (rare, big pool) -> caller fails fast; recovers as cooldowns expire
}
function noteProxyFail(p) { if (p && p.server) { const n = (proxyFails.get(p.server) || 0) + 1; proxyFails.set(p.server, n); if (n >= PROXY_DEAD_AFTER) { proxyCooldown.set(p.server, Date.now() + PROXY_COOLDOWN_MS); proxyFails.set(p.server, 0); log(`[proxy] ${p.server} cooled ${Math.round(PROXY_COOLDOWN_MS / 1000)}s after ${n} LAUNCH fails`); } } } // ONLY launch failures (can't connect) penalize a proxy - NOT solve failures (those can be STT/audio/transient, not the proxy's fault)
function noteProxyOk(p) { if (p && p.server) { proxyFails.delete(p.server); proxyCooldown.delete(p.server); } } // working exit -> clear

export const looksLikeToken = (t) => typeof t === 'string' && t.length > 100 && !/\s/.test(t);
const isBlock = (m) => /AUDIO BLOCKED|doscaptcha|automated queries/i.test(m || '');
const stats = { requests: 0, ok: 0, fail: 0, retries: 0, recycles: 0, recycleFails: 0, watchdogKills: 0, blocks: 0, consecRecycles: 0, started: Date.now(), msSum: 0, msN: 0 };

const FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
  '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-hang-monitor', '--disable-sync', '--disable-breakpad',
  '--disable-component-extensions-with-background-pages', '--disable-ipc-flooding-protection', '--metrics-recording-only',
  '--password-store=basic', '--use-mock-keychain', '--no-pings', '--disable-domain-reliability',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints', '--mute-audio',
];
function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const c = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  throw new Error('Chrome not found - set CHROME_BIN');
}
const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForPort(port, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { try { await fetch(`http://localhost:${port}/json/version`); return; } catch {} await sleep(250); } throw new Error('CDP not up on ' + port); }
function killTree(proc) { if (!proc || proc.killed) return; try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill('SIGKILL'); } catch {} }

let portCounter = +(process.env.CDP_PORT_START || 9600), globalBrowsers = 0;
export class Browser {
  constructor(id, opts) { this.id = id; this.opts = opts; this.proc = null; this.cdp = null; this.tabs = []; this.dir = null; this.port = 0; this.uses = 0; this.bad = null; this.recycling = false; this.dead = false; this.ready = false; this.lastUsed = 0; this.proxy = null; this.retiring = false; this.consecFails = 0; }
  alive() { return !!this.proc && !this.proc.killed && !!this.cdp && !this.cdp.closed; }
  async close() {                                        // kill+wipe WITHOUT relaunch (rolling replacement)
    this.ready = false; this.retiring = true;
    for (const t of this.tabs) { try { await t.sess.close(); } catch {} }
    try { this.cdp && this.cdp.close(); } catch {}
    killTree(this.proc); try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
  idleTab() { return this.tabs.find((t) => !t.busy); }
  busyTabs() { return this.tabs.filter((t) => t.busy).length; }
  async launch() {
    this.ready = false; this.uses = 0; this.tabs = []; this.port = portCounter++;
    this.proxy = PER_TAB_PROXY ? null : pickProxy(); // browser-level proxy (one IP/Chrome); in PER_TAB_PROXY mode each tab picks its own below
    if (PROXY_MODE && PROXIES.length && !PER_TAB_PROXY && !this.proxy) throw new Error('all proxies dead/blacklisted - refusing box-IP fallback (PROXY_MODE=on)'); // fail fast (chosen policy): never silently serve on the box IP when proxies were required
    this.dir = path.join(os.tmpdir(), `rev2-${this.port}-${process.pid}`);
    const args = [`--remote-debugging-port=${this.port}`, `--user-data-dir=${this.dir}`, `--disk-cache-dir=${CACHE_DIR}`, `--window-size=${VIEWPORT_W},${VIEWPORT_H}`, ...FLAGS];
    if (HEADLESS) args.push('--headless=new', `--user-agent=${UA}`);   // else: a normal visible Chrome window
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader');
    if (this.proxy) args.push(`--proxy-server=${this.proxy.server}`);
    if (EXTRA_FLAGS) args.push(...EXTRA_FLAGS.split(/\s+/).filter(Boolean));
    args.push('about:blank');                              // start on a blank tab, not Chrome's "New Tab" page
    this.proc = (process.platform === 'linux' && !HEADLESS) ? spawn('xvfb-run', ['-a', CHROME, ...args], { stdio: 'ignore' }) : spawn(CHROME, args, { stdio: 'ignore' });
    await waitForPort(this.port);
    this.cdp = await connect(`http://localhost:${this.port}`);
    const pa = this.proxy && this.proxy.username ? { username: this.proxy.username, password: this.proxy.password } : null;
    const openTab = async (i) => {
      let proxyServer = null, tabPa = pa;
      if (PER_TAB_PROXY) { const p = pickProxy(); if (p) { proxyServer = p.server; tabPa = p.username ? { username: p.username, password: p.password } : null; } else if (PROXY_MODE && PROXIES.length) throw new Error('all proxies dead/blacklisted - refusing box-IP fallback (PER_TAB_PROXY)'); } // each tab = its own browser context + egress IP; fail fast if none left
      const sess = new V2Session(this.cdp, { ...this.opts, reuseInitialTab: i === 0 && !PER_TAB_PROXY, log: DEBUG ? (...a) => tui.step(true, sess.reqId ?? DBG_ID, `W${this.id}`, 'SOLVE', a.join(' ')) : () => {}, proxyServer, proxyAuth: tabPa }); // tab 0 reuses the launch about:blank tab; DEBUG: each step uses the session's OWN request id (set in serve) so concurrent solves never cross-label
      await sess.open(); return { sess, busy: false };
    };
    const first = await openTab(0);                          // tab 0 FIRST (sequentially): it claims the launch about:blank tab before any sibling createTarget can race for it
    const rest = await Promise.all(Array.from({ length: TABS_PER_BROWSER - 1 }, (_, i) => openTab(i + 1))); // remaining tabs in parallel (each its own scoped OOPIFs; in PER_TAB_PROXY mode each its own IP)
    this.tabs = [first, ...rest];
    this.bad = null; this.ready = true;
  }
  async serve(tab, id) {                                 // tab reserved (busy) by caller; may throw (STT miss / audio-block)
    tab.sess.reqId = id;                                 // stamp this serve's request id so the session's SOLVE step logs carry the right #id under concurrency
    const tok = await tab.sess.solveOnce();
    if (!looksLikeToken(tok)) throw new Error('bad token: ' + JSON.stringify(String(tok).slice(0, 30)));
    this.uses++; this.lastUsed = Date.now(); this.consecFails = 0; noteProxyOk(this.proxy); return tok; // this exit works -> clear blacklist count + failure streak
  }
  async rearm(tab) {                                     // background re-arm: reset the widget for the next solve; release the tab
    tab.rearming = true;                                 // tell acquire() this tab will free shortly -> WAIT for it instead of spawning a new browser (fixes: 2nd request opened a new browser during the ~1s re-arm)
    try { await tab.sess.reset(); } catch (e) { this.markBad('reset: ' + e.message); } finally { tab.busy = false; tab.rearming = false; }
  }
  markBad(why) { if (this.bad || this.recycling) return; this.bad = why || 'bad'; this.ready = false; this.recycle().catch(() => {}); }
  async recycle() {                                      // relaunch the whole browser (fresh profile + all tabs) w/ backoff
    if (this.recycling) return; this.recycling = true; this.ready = false;
    for (const t of this.tabs) { try { await t.sess.close(); } catch {} }
    try { this.cdp && this.cdp.close(); } catch {}
    killTree(this.proc); await sleep(300);
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
    let err;
    for (let a = 0; a < RECYCLE_RETRIES; a++) {
      try { await this.launch(); this.bad = null; this.recycling = false; stats.recycles++; return; }
      catch (e) { err = e; killTree(this.proc); await sleep(500 * (a + 1)); }
    }
    this.recycling = false; this.dead = true; this.bad = 'relaunch failed: ' + (err && err.message); stats.recycleFails++;
  }
}
export class Fleet {
  constructor(opts) { this.opts = opts; this.browsers = []; }
  pruneDead() { this.browsers = this.browsers.filter((b) => { if (b.dead) { globalBrowsers = Math.max(0, globalBrowsers - 1); return false; } return true; }); }
  async acquire(deadline = Date.now() + 40000) {
    while (Date.now() < deadline) {
      this.pruneDead();
      for (const b of this.browsers) { if (b.ready && !b.bad && !b.retiring && b.alive()) { const tab = b.idleTab(); if (tab) { tab.busy = true; return { browser: b, tab }; } } }
      const rearmingSoon = this.browsers.some((b) => b.ready && !b.bad && !b.retiring && b.tabs.some((t) => t.rearming)); // a just-solved browser is re-arming and will free within ~1s -> prefer reusing it over launching a new browser
      const live = this.browsers.filter((b) => !b.retiring).length;
      if (!rearmingSoon && live < BROWSERS_PER_FLEET && globalBrowsers < MAX_BROWSERS) {
        globalBrowsers++; const b = new Browser(globalBrowsers, this.opts); this.browsers.push(b);
        try { await b.launch(); } catch (e) { noteProxyFail(b.proxy); this.browsers = this.browsers.filter((x) => x !== b); globalBrowsers--; throw e; } // launch failed -> count against its proxy (dead-exit detection)
        const tab = b.idleTab(); if (tab) { tab.busy = true; return { browser: b, tab }; }
      }
      await sleep(50);
    }
    throw new Error('no tab available within deadline (pool saturated or all proxies dead - raise MAX_BROWSERS/BROWSERS_PER_FLEET/TABS_PER_BROWSER, or check proxies)');
  }
  // ROLLING REPLACEMENT: launch a fresh browser, THEN retire the burned one - no recycle capacity gap.
  async rollReplace(old) {
    if (old.retiring) return; old.retiring = true; old.ready = false;
    globalBrowsers++; const nb = new Browser(globalBrowsers, this.opts); this.browsers.push(nb);
    let launched = false;
    try { await nb.launch(); launched = true; } catch (e) { noteProxyFail(nb.proxy); this.browsers = this.browsers.filter((x) => x !== nb); globalBrowsers--; }
    if (!launched) { old.retiring = false; old.ready = !old.bad; return; } // FIX: replacement failed -> keep `old` in service (no capacity loss); next solve retries the roll
    const drainEnd = Date.now() + 30000;                  // FIX: drain in-flight SIBLING tabs (multi-tab) before closing - don't abort healthy mid-solve tabs (they'd waste a solve + retry)
    while (old.busyTabs() > 0 && Date.now() < drainEnd) await sleep(100);
    this.browsers = this.browsers.filter((x) => x !== old); globalBrowsers = Math.max(0, globalBrowsers - 1);
    try { await old.close(); } catch {}
    stats.recycles++;                                     // count rolling replacements too (was only counted in recycle())
  }
}
const fleets = new Map();
const keyOf = (o) => `${o.enterprise ? 'e:' : ''}${o.sitekey}|${o.targetUrl}`;
function fleetFor(opts) { const k = keyOf(opts); let f = fleets.get(k); if (!f) { f = new Fleet(opts); fleets.set(k, f); } return f; }

// try up to `tries` tabs. STT MISS -> reset just that tab + retry. AUDIO BLOCK -> recycle the whole browser (fresh profile).
export async function serveWithRetry(fleet, id, tries = RETRIES) {
  const deadline = Date.now() + TOKEN_DEADLINE;             // bound the whole /token (acquire waits + retries) - never hang on a dead pool
  let lastErr;
  for (let i = 0; i < tries && Date.now() < deadline; i++) {
    let h;
    try { h = await fleet.acquire(deadline); } catch (e) { lastErr = e; break; }
    try { return { browser: h.browser, tab: h.tab, token: await h.browser.serve(h.tab, id) }; }
    catch (e) {
      lastErr = e; stats.retries++;
      if (isBlock(e.message)) { stats.blocks++; h.browser.markBad('audio-block: ' + e.message); }
      else if (/rotate-exit/.test(e.message)) { stats.consecRecycles++; h.browser.markBad('low-trust exit -> rotate proxy: ' + e.message); } // multi-solve = low-trust IP: recycle to a fresh proxy NOW (fail-fast for CPM), don't re-arm the same slow exit
      else if (++h.browser.consecFails >= FAIL_RECYCLE) { stats.consecRecycles++; h.browser.markBad('consec-fails(' + h.browser.consecFails + '): ' + e.message); } // recycle the BROWSER (fresh profile + rotate to next proxy) - but do NOT blacklist the proxy: a solve fail isn't proof the exit is bad (could be audio/STT/transient). Blacklisting here caused the pool-collapse death-spiral.
      else { h.browser.rearm(h.tab).catch(() => {}); } // STT miss: just re-arm that tab, keep the browser + its other tabs
    }
  }
  throw lastErr || new Error('serve failed');
}

export function watchdog() {
  for (const f of fleets.values()) {
    for (const b of f.browsers) {
      if (b.dead || b.recycling || b.retiring || b.busyTabs() > 0) continue;
      if (b.ready && !b.alive()) { stats.watchdogKills++; b.markBad('watchdog: chrome/cdp dead'); }
    }
    f.pruneDead();
  }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    let data = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); resolve('{}'); } else data += c; });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', () => resolve('{}'));
  });
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/health') { res.end(JSON.stringify({ ok: true, globalBrowsers, fleets: [...fleets.entries()].map(([k, f]) => ({ key: k, browsers: f.browsers.length, tabs: f.browsers.reduce((n, b) => n + b.tabs.length, 0) })) })); return; }
  if (u.pathname === '/stats') {
    res.end(JSON.stringify({
      ...stats, avgMs: stats.msN ? Math.round(stats.msSum / stats.msN) : 0, uptimeS: Math.round((Date.now() - stats.started) / 1000), globalBrowsers,
      fleets: [...fleets.entries()].map(([k, f]) => ({ key: k, browsers: f.browsers.map((b) => ({ id: b.id, uses: b.uses, tabs: b.tabs.length, busyTabs: b.busyTabs(), ready: b.ready, bad: b.bad, recycling: b.recycling, alive: b.alive(), proxy: b.proxy ? b.proxy.server : null })) })),
    }));
    return;
  }
  if (u.pathname !== '/token') { res.statusCode = 404; res.end('{"error":"use /token?sitekey=&target="}'); return; }
  let body = {};
  if (req.method === 'POST') { try { body = JSON.parse(await readBody(req)); } catch {} }
  const h = req.headers;
  const sitekey = body.sitekey || h['x-sitekey'] || u.searchParams.get('sitekey');
  const targetUrl = body.target || body.url || body.targetUrl || h['x-target'] || h['x-url'] || u.searchParams.get('target') || u.searchParams.get('targetUrl');
  const enterprise = body.enterprise === true || body.enterprise === '1' || h['x-enterprise'] === '1' || u.searchParams.get('enterprise') === '1';
  if (!sitekey || !targetUrl) { res.statusCode = 400; res.end('{"error":"sitekey & target required (POST {sitekey,target} or ?sitekey=&target=)"}'); return; }
  const id = tui.nextId(); DBG_ID = id;                  // tag this request's solve steps with #id
  tui.step(DEBUG, id, '', 'RECV', `${(targetUrl || '').slice(0, 45)} ${A_DIM}|${A_RST} ${(sitekey || '').slice(0, 22)}${enterprise ? ' (ent)' : ''}`);
  const t0 = Date.now(); stats.requests++;
  try {
    const fleet = fleetFor({ sitekey, targetUrl, enterprise });
    tui.step(DEBUG, id, '', 'ACQUIRE', 'browser/tab');
    const { browser, tab, token } = await serveWithRetry(fleet, id);
    const ms = Date.now() - t0; stats.ok++; stats.msSum += ms; stats.msN++;
    tui.step(DEBUG, id, `W${browser.id}`, 'TOKEN', `len ${token.length}`);
    res.end(JSON.stringify({ elapsed: ms, token }));
    tui.result({ debug: DEBUG, id, label: `W${browser.id}`, ok: true, ms, token });
    if (browser.uses >= SOLVES_PER_BROWSER) { tab.busy = false; (ROLLING ? fleet.rollReplace(browser) : browser.recycle()).catch(() => {}); } // retire burned profile (rolling = no gap)
    else browser.rearm(tab);                             // background re-arm (resets + releases the tab)
  } catch (e) { const ms = Date.now() - t0; stats.fail++; res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message || e), ms })); tui.result({ debug: DEBUG, id, label: 'W-', ok: false, ms, err: String(e?.message || e) }); }
});
const A_DIM = '\x1b[2m', A_RST = '\x1b[0m';
process.on('SIGINT', () => { for (const f of fleets.values()) for (const b of f.browsers) killTree(b.proc); process.exit(0); });
process.on('SIGTERM', () => { for (const f of fleets.values()) for (const b of f.browsers) killTree(b.proc); process.exit(0); });

export function startServer() {
  if (WATCHDOG_MS > 0) { const t = setInterval(watchdog, WATCHDOG_MS); if (t.unref) t.unref(); }
  server.listen(PORT, () => {
    const cfg = `Browsers: ${BROWSERS_PER_FLEET} | Tabs: ${TABS_PER_BROWSER} | STT: ${process.env.STT || 'vosk'} | Proxies: ${PROXY_MODE ? `On (${PROXIES.length})` : 'Off'} | Headless: ${HEADLESS ? 'On' : 'Off'}`;
    tui.printBanner({ port: PORT, cfg, debug: DEBUG });
  });
}
const isMain = import.meta.main === true || import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) startServer();                                   // run directly: `node pool-server.mjs`
export { fleets, stats };
