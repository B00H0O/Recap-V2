// v2 CPM test: C concurrent GET /token, measure throughput.
//   PORT=4200 C=8 DUR=30000 [SITEKEY=.. TARGET=..] node cpm.mjs
const PORT = +(process.env.PORT || 4200), HOST = process.env.HOST || '127.0.0.1';
const C = +(process.env.C || 6), DUR = +(process.env.DUR || 30000);
const SK = process.env.SITEKEY || '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
const TG = process.env.TARGET || 'https://example.com/login';
const TURL = `http://${HOST}:${PORT}/token?sitekey=${SK}&target=${encodeURIComponent(TG)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://${HOST}:${PORT}/health`)).ok) return true; } catch {} await sleep(500); } return false; }
async function mint() { const c = new AbortController(); const to = setTimeout(() => c.abort(), 70000); const s = Date.now(); try { const r = await fetch(TURL, { signal: c.signal }); const j = await r.json(); return { ...j, _ms: Date.now() - s }; } catch (e) { return { error: e.message, _ms: Date.now() - s }; } finally { clearTimeout(to); } }
let ok = 0, fail = 0, stop = false, sumMs = 0; const lat = []; const errs = {}; let okAtStop = null, elAtStop = null;
async function worker() { while (!stop) { const j = await mint(); if (j && j.token) { ok++; sumMs += j._ms; lat.push(j._ms); } else { fail++; const k = String((j && j.error) || 'no-token').slice(0, 40); errs[k] = (errs[k] || 0) + 1; } } }
(async () => {
  if (!await health()) { console.log('POOL NOT HEALTHY on :' + PORT); process.exit(1); }
  console.log(`v2 CPM -> C=${C} dur=${DUR / 1000}s @ ${TURL}\n`);
  const t0 = Date.now();
  const tick = setInterval(() => { const el = (Date.now() - t0) / 1000; console.log(`  [${el.toFixed(0)}s] CPM=${Math.round(ok / (el / 60))} ok=${ok} fail=${fail}`); }, 3000);
  setTimeout(() => { stop = true; okAtStop = ok; elAtStop = (Date.now() - t0) / 1000; }, DUR);
  await Promise.all(Array.from({ length: C }, () => worker()));
  clearInterval(tick); await sleep(500); lat.sort((a, b) => a - b);
  const cpm = Math.round(okAtStop / (elAtStop / 60));
  console.log(`\n===== RESULT =====`);
  console.log(`tokens ${okAtStop} | fail ${fail} | success ${Math.round(100 * okAtStop / (okAtStop + fail || 1))}% | window ${Math.round(elAtStop)}s`);
  console.log(`CPM = ${cpm}`);
  console.log(`latency avg ${ok ? Math.round(sumMs / ok) : 0}ms | p50 ${lat[Math.floor(lat.length * 0.5)] || 0}ms | p90 ${lat[Math.floor(lat.length * 0.9)] || 0}ms`);
  if (Object.keys(errs).length) console.log(`errors: ${JSON.stringify(errs)}`);
  process.exit(0);
})();
