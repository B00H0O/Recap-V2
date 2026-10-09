// HTTP /token service for reCAPTCHA v2 (+ v2-Enterprise). Each request runs a full audio solve
// (checkbox -> bframe -> audio -> STT -> verify) in its own tab, capped at CONC concurrent solves.
// Your bots call:  GET /token?sitekey=6L..&target=https://site/login[&enterprise=1]
//   -> { "token": "...", "ms": 7200 }
// Setup: launch a real Chrome first:  chrome.exe --remote-debugging-port=9333 --user-data-dir="C:\path\profile"
// Run:   CONNECT=http://localhost:9333 PORT=4200 CONC=4 node server.mjs
import http from 'node:http';
import { solveV2 } from './solve-v2.mjs';

const PORT = +(process.env.PORT || 4200);
const BROWSER = process.env.CONNECT || 'http://localhost:9333';
const CONC = +(process.env.CONC || 4); // concurrent solves (each uses a tab + CPU for STT)

let active = 0; const queue = [];
const pump = () => { if (active >= CONC || !queue.length) return; const job = queue.shift(); active++; job().finally(() => { active--; pump(); }); };
const submit = (fn) => new Promise((res, rej) => { queue.push(() => fn().then(res, rej)); pump(); });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/health') { res.end(JSON.stringify({ ok: true, active, queued: queue.length, conc: CONC })); return; }
  if (u.pathname !== '/token') { res.statusCode = 404; res.end('{"error":"use /token?sitekey=&target=[&enterprise=1]"}'); return; }
  const sitekey = u.searchParams.get('sitekey');
  const targetUrl = u.searchParams.get('target') || u.searchParams.get('targetUrl');
  const enterprise = u.searchParams.get('enterprise') === '1';
  if (!sitekey || !targetUrl) { res.statusCode = 400; res.end('{"error":"sitekey & target required"}'); return; }
  const t0 = Date.now();
  try {
    const token = await submit(() => solveV2({ browserURL: BROWSER, sitekey, targetUrl, enterprise, log: () => {} }));
    res.end(JSON.stringify({ token, ms: Date.now() - t0 }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message || e), ms: Date.now() - t0 }));
  }
});
server.listen(PORT, () => console.log(`v2 /token on http://localhost:${PORT}  (CONC=${CONC}, browser=${BROWSER})`));
