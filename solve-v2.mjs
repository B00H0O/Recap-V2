// reCAPTCHA v2 solver - raw CDP + real Chrome + document interception + audio->STT (v2 & v2-Enterprise).
// The token is minted ON the target origin (interception): no heavy page, doc-level antibot sidestepped.
//
// Two ways to use:
//   solveV2(opts)            one-shot: open page -> solve -> close (simple).
//   new V2Session(cdp,opts)  WARM REUSE: open() the widget ONCE, then solveOnce()+reset() repeatedly,
//                            reusing the loaded page (skips page-load+api.js+engine+render per solve).
//
// The anchor + bframe are cross-origin (google.com) OOPIFs (Target.setAutoAttach); they attach with an
// empty URL then navigate, so we resolve which is which by polling each child session's location.href.
//
// CLI: CONNECT=.. SITEKEY=.. TARGET_URL=.. [ENTERPRISE=1] [WARM=N] node solve-v2.mjs
import { fileURLToPath } from 'node:url';
import { connect } from './cdp.mjs';
import { transcribe, shutdownSTT } from './stt.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tunable latency knobs (MEASURED-optimized defaults; old "legacy" values in comments for A/B). Lower = faster cycle.
const TUNE = {
  reset: +(process.env.RESET_SLEEP || 150),     // post-grecaptcha.reset() pre-wait (was 700; waitFrame polls anyway)
  click: +(process.env.CLICK_SLEEP || 150),     // checkbox->bframe poll gap (was 300)
  probe: +(process.env.PROBE_INTERVAL || 70),   // audio-button / audio-URL poll interval (was 120)
  verify: +(process.env.VERIFY_POLL || 100),    // token poll gap after verify-click (was 150)
};
// Stealth patch - fixes JS-level headless tells (MEASURED on v3: lifts headless 0.3->0.8 = headful). Conditional = no-op in headful.
const STEALTH_PATCH = `(function(){try{
Object.defineProperty(navigator,'webdriver',{get:function(){return undefined;}});
var pq=navigator.permissions&&navigator.permissions.query;
if(pq)navigator.permissions.query=function(p){return(p&&p.name==='notifications')?Promise.resolve({state:(window.Notification&&Notification.permission)||'prompt',onchange:null}):pq.call(navigator.permissions,p);};
if(!window.chrome)window.chrome={runtime:{},app:{isInstalled:false},csi:function(){},loadTimes:function(){}};
if(!window.outerWidth)Object.defineProperty(window,'outerWidth',{get:function(){return window.innerWidth||1280;}});
if(!window.outerHeight)Object.defineProperty(window,'outerHeight',{get:function(){return (window.innerHeight||720)+85;}});
}catch(e){}})();`;
// Native-level fingerprint realism. Fixes headless tells reCAPTCHA reads: empty UA-CH navigator.userAgentData
// (fp idx 72) + the impossible screen<viewport (headless screen defaults 800x600 vs a wider viewport, fp idx 67).
// CDP-level, no detectable JS hooks.
async function applyRealismPatches(cdp, sid, ua) {
  if (ua) {
    const major = (ua.match(/Chrome\/(\d+)/) || [])[1] || '149';
    const isWin = /Windows/.test(ua), isMac = /Macintosh|Mac OS/.test(ua);
    const platform = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux';
    const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '99' }];
    const fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9', userAgentMetadata: { brands, fullVersionList, fullVersion: major + '.0.0.0', platform, platformVersion: isWin ? '15.0.0' : isMac ? '14.0.0' : '6.5.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false } }, sid).catch(() => {});
  }
  const vw = Number(process.env.VIEWPORT_W) || 1024, vh = Number(process.env.VIEWPORT_H) || 768;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false, screenWidth: Math.max(1920, vw), screenHeight: Math.max(1080, vh), screenOrientation: { type: 'landscapePrimary', angle: 0 } }, sid).catch(() => {});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_PATCH }, sid).catch(() => {});
}
const V2_PAGE = (sitekey, enterprise) =>
  `<!doctype html><html><head><meta charset=utf-8><title> </title>` +
  `<script src="https://www.google.com/recaptcha/${enterprise ? 'enterprise' : 'api'}.js" async defer></script>` +
  `</head><body><div class="g-recaptcha" data-sitekey="${sitekey}"></div></body></html>`;

async function evalIn(cdp, sid, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error');
  return r.result?.value;
}
async function waitIn(cdp, getSid, expression, { timeout = 20000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const sid = getSid();
    if (sid) { try { const v = await evalIn(cdp, sid, expression); if (v) return v; } catch {} }
    await sleep(interval);
  }
  return null;
}

export class V2Session {
  constructor(cdp, { sitekey, targetUrl, enterprise = false, log = () => {}, proxyAuth = null, proxyServer = null, reuseInitialTab = false }) {
    Object.assign(this, { cdp, sitekey, targetUrl, enterprise, log, proxyAuth, proxyServer, reuseInitialTab });
    this.browserContextId = null;
    this.frames = { anchor: null, bframe: null };
    this.kids = new Set(); this.sessByTarget = new Map();
    this.pageSession = null; this.pageTarget = null; this.served = false;
    this.gpath = enterprise ? 'window.grecaptcha.enterprise' : 'window.grecaptcha';
    this.tokenExpr = `(()=>{try{return (${this.gpath}.getResponse&&${this.gpath}.getResponse())||''}catch(e){return ''}})()`;
  }
  classify(url, sid) {
    if (!url) return;
    if (/recaptcha\/(api2|enterprise)\/anchor/.test(url) && !this.frames.anchor) { this.frames.anchor = sid; if (!this._silent) this.log('checkbox ready'); }
    else if (/recaptcha\/(api2|enterprise)\/bframe/.test(url) && !this.frames.bframe) { this.frames.bframe = sid; if (!this._silent) this.log('challenge opened'); }
  }
  async resolveFrames() {
    for (const sid of this.kids) { if (this.frames.anchor && this.frames.bframe) break; try { this.classify(await evalIn(this.cdp, sid, 'location.href'), sid); } catch {} }
  }
  async waitFrame(kind, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (this.frames[kind]) return this.frames[kind]; await this.resolveFrames(); if (this.frames[kind]) return this.frames[kind]; await sleep(120); }
    return null;
  }
  async open() {
    const { cdp } = this; const _t0 = Date.now();
    // PER-TAB proxy: give this tab its own browser context bound to its own egress IP (Kasada-style - many IPs from
    // few Chromes). NB: browser contexts score ~0.2 on v3 (Google detects the incognito/context) - v2-ONLY (pass/fail).
    if (this.proxyServer) this.browserContextId = (await cdp.send('Target.createBrowserContext', { proxyServer: this.proxyServer, proxyBypassList: '<-loopback>' })).browserContextId;
    // REUSE the about:blank tab Chrome already opened at launch instead of spawning a 2nd one (no dead tab left
    // behind). Only the browser's FIRST tab claims it, and only outside a per-tab proxy context (which needs its
    // own browserContext tab). Tabs 2+ (multi-tab) still create their own targets.
    if (this.reuseInitialTab && !this.browserContextId) {
      try { const { targetInfos } = await cdp.send('Target.getTargets'); const ex = (targetInfos || []).find((t) => t.type === 'page' && /^about:blank/.test(t.url || '')); if (ex) this.pageTarget = ex.targetId; } catch {}
    }
    if (!this.pageTarget) this.pageTarget = (await cdp.send('Target.createTarget', { url: 'about:blank', ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}) })).targetId;
    this.pageSession = (await cdp.send('Target.attachToTarget', { targetId: this.pageTarget, flatten: true })).sessionId;
    const ua = ((cdp.version && cdp.version['User-Agent']) || '').replace(/Headless/g, '');
    await applyRealismPatches(cdp, this.pageSession, ua); // UA-CH + realistic screen + stealth patch (fingerprint realism)
    // MULTI-TAB: scope iframe adoption to THIS page's children (envelope sessionId === pageSession), so several
    // V2Sessions can share one Chrome without cross-adopting each other's anchor/bframe OOPIFs. targetInfoChanged
    // stays global but is naturally scoped by the sessByTarget lookup (only the owning session has the targetId).
    cdp.on('Target.attachedToTarget', (p) => {
      const sid = p.sessionId; const ti = p.targetInfo || {};
      if (ti.targetId) this.sessByTarget.set(ti.targetId, sid);
      if (ti.type === 'iframe') this.kids.add(sid);
      cdp.send('Runtime.enable', {}, sid).catch(() => {});
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
      this.classify(ti.url, sid);
    }, this.pageSession);
    cdp.on('Target.targetInfoChanged', (p) => { const ti = p.targetInfo || {}; const sid = this.sessByTarget.get(ti.targetId); if (sid) this.classify(ti.url, sid); });
    cdp.on('Fetch.requestPaused', async (p, sid) => {
      if (sid !== this.pageSession) return;
      try {
        if (!this.served && p.resourceType === 'Document') {
          this.served = true;
          await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(V2_PAGE(this.sitekey, this.enterprise)).toString('base64') }, sid);
          if (!this.proxyAuth) await cdp.send('Fetch.disable', {}, sid).catch(() => {}); // keep Fetch on for proxy auth
        } else { await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid); }
      } catch {}
    }, this.pageSession);
    // proxy auth (user:pass proxies): answer the 407. needs handleAuthRequests + broadened patterns (api.js egresses via the proxy).
    if (this.proxyAuth) cdp.on('Fetch.authRequired', async (p, sid) => { if (sid !== this.pageSession) return; try { await cdp.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: this.proxyAuth.username, password: this.proxyAuth.password } }, sid); } catch {} }, this.pageSession);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, this.pageSession);
    await cdp.send('Fetch.enable', { patterns: this.proxyAuth ? [{ urlPattern: '*', requestStage: 'Request' }] : [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }], handleAuthRequests: !!this.proxyAuth }, this.pageSession);
    await cdp.send('Page.enable', {}, this.pageSession);
    await cdp.send('Runtime.enable', {}, this.pageSession);
    this.log('page loaded (intercepted)');
    await cdp.send('Page.navigate', { url: this.targetUrl }, this.pageSession);
    if (!(await this.waitFrame('anchor'))) throw new Error('anchor iframe never appeared');
    if (process.env.TIMING === '1') this._tOpen = Date.now() - _t0;
  }
  // Re-arm the widget for another solve (reuses the loaded page) - the v2 equivalent of v3's re-execute.
  // grecaptcha.reset() re-renders the anchor (and bframe) iframes as NEW OOPIF sessions, so drop the stale
  // refs and re-resolve before the next solve.
  async reset() {
    const _t0 = Date.now();
    this._silent = true;                                      // background re-arm: don't emit checkbox/challenge step logs - they belong to no active request (kept the previous solve's #id looking "mixed")
    try {
      await evalIn(this.cdp, this.pageSession, `(()=>{try{${this.gpath}.reset();return true}catch(e){return false}})()`).catch(() => {});
      this.frames.anchor = null; this.frames.bframe = null;
      await sleep(TUNE.reset);                                 // MEASURED: was 700 (dead wait); waitFrame polls below, so 150 + poll catches the re-rendered anchor just as fast (~13% off the cycle)
      if (!(await this.waitFrame('anchor', 10000))) throw new Error('anchor did not re-arm after reset');
    } finally { this._silent = false; }
    if (process.env.TIMING === '1') this._tReset = Date.now() - _t0;
  }
  // NB: synthetic el.click() is used deliberately. A CDP Input "trusted" click was TESTED (2026-06-15) and lost
  // decisively (7/12 vs 12/12 solved, 2 vs 7 instant-passes, 6663 vs 2675ms) - reCAPTCHA's checkbox/instant-pass
  // decision is driven by IP+profile reputation, NOT click trustedness (synthetic clicks instant-pass fine on a
  // clean IP), and trusted-click coordinates add fragility. Kept synthetic.
  async solveOnce() {
    const { cdp } = this; const T = process.env.TIMING === '1'; const t = {}; let m = Date.now();
    const lap = (k) => { if (T) { t[k] = (t[k] || 0) + (Date.now() - m); m = Date.now(); } };
    if (T) this._t = t;
    if (!(await waitIn(cdp, () => this.frames.anchor, "(()=>{const c=document.getElementById('recaptcha-anchor');if(c){c.click();return true}return false})()"))) throw new Error('checkbox not clickable');
    for (let i = 0; i < 12; i++) {
      const tk = await evalIn(cdp, this.pageSession, this.tokenExpr).catch(() => '');
      if (tk && tk.length > 20) { if (T) { t.click = Date.now() - m; t.instant = true; } return tk; } // instant pass
      await this.resolveFrames(); if (this.frames.bframe) break; await sleep(TUNE.click);
    }
    if (!this.frames.bframe) await this.waitFrame('bframe', 4000);
    if (!this.frames.bframe) throw new Error('no challenge appeared and no instant token');
    lap('click');                                            // checkbox click -> challenge (bframe) present
    { const tk = await evalIn(cdp, this.pageSession, this.tokenExpr).catch(() => ''); if (tk && tk.length > 20) { if (T) t.instant = true; return tk; } } // instant-pass that landed just AS the challenge frame appeared - take the token, don't open audio (fixes: "auto-solved but did audio anyway")
    if (!(await waitIn(cdp, () => this.frames.bframe, "(()=>{const b=document.getElementById('recaptcha-audio-button');if(b){b.click();return true}return false})()", { timeout: 8000, interval: TUNE.probe }))) throw new Error('audio button not found');
    const probeExpr = "(()=>{const b=document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text');if(b)return 'BLOCK:'+(b.innerText||'').slice(0,60);const a=document.querySelector('.rc-audiochallenge-tdownload-link');if(a&&a.href)return a.href;const s=document.getElementById('audio-source');if(s&&s.src)return s.src;return ''})()";
    // SMART RETRY - separate the two reasons a round repeats, so normal solves FAIL FAST (high CPM) while a reCAPTCHA-
    // REQUIRED multi-solve chain COMPLETES (no reliance on a big MAX, which would grind every solve). MEASURED 2026-06-18:
    //   - `fails` = STT-empty / WRONG-answer rounds -> cap at MAX (default 4) -> bail fast + let the pool rotate exits.
    //     (A/B: MAX=4 -> 137 CPM/98%; bumping MAX to 12 to "fix" multi-solve TANKED throughput 3.6x - a solve needing >2
    //      rounds GRINDS ~11.5s vs fail-fast 3.2s+retry. So MAX stays small.)
    //   - `multi` = reCAPTCHA "Multiple correct solutions required" = the answer was ACCEPTED and a LOW-TRUST session must
    //     solve MORE. That's PROGRESS, NOT a failure -> keep going (count `multi`, NOT `fails`), bounded by MULTI_SOLVE_MAX
    //     + the wall-clock AUDIO_TOTAL_BUDGET. So a flagged IP's 5-9-round chain completes at the DEFAULT MAX=4, while a
    //     genuinely-failing solve still bails after 4.
    const MAX = +(process.env.MAX_AUDIO_TRIES || 4);                // fail-fast cap: STT-empty / wrong-answer rounds before bailing
    const MULTI_MAX = +(process.env.MULTI_SOLVE_MAX || 20);         // max "solve more" PROGRESS rounds (chain length) - bounded also by AUDIO_TOTAL_BUDGET
    const AUDIO_LOAD_TO = +(process.env.AUDIO_LOAD_TIMEOUT || 6000); // clip-load wait (MEASURED: a working exit loads the clip in <2.6s even via residential proxy)
    const LOAD_RETRY = +(process.env.AUDIO_LOAD_RETRY || 2);         // consecutive clip-never-loaded attempts before bailing -> pool rotates to another exit
    const AUDIO_BUDGET = +(process.env.AUDIO_TOTAL_BUDGET || 28000); // HARD wall-clock cap on the whole audio phase (so even a multi-solve chain via a slow exit can't hang; ~9s for a fast chain, well under)
    const ROUND_DELAY = +(process.env.ROUND_DELAY || 120);          // ms between audio rounds - keep low so multi-solve/retry stays fast (no idle wait)
    const isMulti = (m) => /multiple correct|solve more|more solutions|solve.*more/i.test(m || ''); // reCAPTCHA "Multiple correct solutions required - please solve more."
    let fails = 0, multi = 0, loadFails = 0; const audioStart = Date.now();
    while (fails < MAX && multi < MULTI_MAX && Date.now() - audioStart < AUDIO_BUDGET) {
      const status = await waitIn(cdp, () => this.frames.bframe, probeExpr, { timeout: AUDIO_LOAD_TO, interval: TUNE.probe });
      lap('audioBtn');                                       // audio-button click -> audio clip URL ready
      if (status && status.startsWith('BLOCK:')) throw new Error('AUDIO BLOCKED by Google: ' + status.slice(6));
      if (!status) {
        // EXIT problem: clip didn't load in time (network/exit, not hard audio). Reload once; if it keeps stalling, bail
        // FAST so the pool rotates to another browser/proxy (better than re-hitting the same slow exit).
        if (++loadFails >= LOAD_RETRY) throw new Error('audio challenge did not load');
        this.log(`audio clip stalled (>${AUDIO_LOAD_TO}ms) - reloading (${loadFails}/${LOAD_RETRY})`);
      } else {
        loadFails = 0;                                       // a clip loaded -> exit works
        if (T) t.tries = fails + multi + 1;
        this.log('got audio clip');
        const text = await transcribe(status, this.log, Math.max(4000, AUDIO_BUDGET - (Date.now() - audioStart))); // cap STT to the audio budget left, so one stuck transcription can't blow past AUDIO_TOTAL_BUDGET (the 63s outlier)
        lap('stt');                                          // fetch mp3 (via proxy) + ffmpeg + STT
        if (text) {
          this.log('transcribed:', JSON.stringify(text));
          await evalIn(cdp, this.frames.bframe, `(()=>{const i=document.getElementById('audio-response');i.value=${JSON.stringify(text)};return true})()`);
          await evalIn(cdp, this.frames.bframe, "(()=>{const v=document.getElementById('recaptcha-verify-button');if(v){v.click();return true}return false})()");
          this.log('submitted answer');
          // FAIL-FAST poll: token OR reCAPTCHA's response (error msg / "solve more") - don't burn 6s on a wrong answer.
          const end = Date.now() + 6000; let tok = '', rej = '';
          while (Date.now() < end) {
            tok = await evalIn(cdp, this.pageSession, this.tokenExpr).catch(() => '');
            if (tok && tok.length > 20) { lap('verify'); return tok; }
            rej = await evalIn(cdp, this.frames.bframe, "(()=>{const e=document.querySelector('.rc-audiochallenge-error-message');if(e&&e.innerText&&e.offsetParent)return e.innerText;if(document.querySelector('.rc-doscaptcha-header-text'))return 'doscaptcha';return ''})()").catch(() => '');
            if (rej) break;                                  // got reCAPTCHA's verdict - classify below, no need to keep polling
            await sleep(TUNE.verify);
          }
          if (tok && tok.length > 20) { lap('verify'); return tok; }
          if (isMulti(rej)) { multi++; this.log(`[multi ${multi}/${MULTI_MAX}] answer ACCEPTED - reCAPTCHA wants more, continuing chain`); } // PROGRESS, not a fail
          else { fails++; this.log(`[try ${fails}/${MAX}] rejected (${(rej || 'no-token').slice(0, 30)}) - retry`); }                          // wrong answer / re-prompt -> fail-fast
        } else { fails++; this.log(`[try ${fails}/${MAX}] STT empty - reloading audio`); }
      }
      await evalIn(cdp, this.frames.bframe, "(()=>{const r=document.getElementById('recaptcha-reload-button');if(r){r.click();return true}return false})()").catch(() => {});
      await sleep(ROUND_DELAY);
    }
    const lowTrust = multi >= MULTI_MAX && fails < MAX;        // bailed on the multi-solve cap (low-trust exit forcing rounds), NOT STT misses -> tell the pool to rotate to a fresh proxy
    throw new Error(`${lowTrust ? 'rotate-exit: ' : ''}audio phase failed (fails ${fails}/${MAX}, multi ${multi}/${MULTI_MAX}, ${Date.now() - audioStart}ms)`);
  }
  async close() { try { await this.cdp.send('Target.closeTarget', { targetId: this.pageTarget }); } catch {} if (this.browserContextId) { try { await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }); } catch {} } }
}

// One-shot convenience (unchanged signature; server.mjs uses this).
export async function solveV2(opts) {
  const cdp = await connect(opts.browserURL || 'http://localhost:9333');
  const s = new V2Session(cdp, { ...opts, log: opts.log || console.log });
  try { await s.open(); return await s.solveOnce(); }
  finally { await s.close(); cdp.close(); }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {   // wrapped in an async IIFE so there is NO top-level await
  const fs = await import('node:fs');
  const opts = { browserURL: process.env.CONNECT || 'http://localhost:9333', sitekey: process.env.SITEKEY, targetUrl: process.env.TARGET_URL, enterprise: process.env.ENTERPRISE === '1', log: console.log };
  const WARM = +(process.env.WARM || 0);
  if (WARM > 0) {                                            // warm-reuse benchmark: open once, solve N times
    const cdp = await connect(opts.browserURL);
    const s = new V2Session(cdp, opts);
    const t0 = Date.now(); await s.open(); console.log(`open(): ${Date.now() - t0}ms`);
    for (let i = 1; i <= WARM; i++) {
      const ts = Date.now();
      try { const tok = await s.solveOnce(); fs.writeFileSync('v2-token.txt', tok); console.log(`solve ${i}: ${Date.now() - ts}ms len=${tok.length}`); }
      catch (e) { console.log(`solve ${i}: ERR ${e.message}`); }
      await s.reset();
    }
    await s.close(); cdp.close(); shutdownSTT(); process.exit(0);
  }
  const token = await solveV2(opts);
  fs.writeFileSync('v2-token.txt', token);
  console.log('\nTOKEN:', token);
  shutdownSTT(); process.exit(0);
})();
