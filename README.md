# Recap-V2

reCAPTCHA v2 (checkbox) solver in Node.js. A real Chrome driven over raw CDP, the target document
intercepted so only the widget loads; the audio challenge is downloaded and transcribed offline
(vosk), never sent anywhere.

You send a sitekey and a target URL, you get back JSON `{elapsed, token}` - a
`g-recaptcha-response` valid for v2 and v2 Enterprise, ~2.9 s per solve warm. Not an
image-challenge solver.

## Mint a token

Any sitekey + any target, per request:

```
$ curl "http://localhost:4400/token?sitekey=6L..&target=https://site/login"
{"elapsed":2900,"token":"0cAFcWeA7Hcdbe3v9rqX9CaSgAX8..."}

PS> curl.exe "http://localhost:4400/token?sitekey=6L..&target=https://site/login"
```

## Run

Needs a real Chrome installed, Node, and Python.

1. `npm install` (dep: `ws`).
2. `pip install vosk SpeechRecognition imageio-ffmpeg` - STT runs in Python.
3. Download the vosk model (NOT in the repo, ~40 MB) from
   https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip and unzip it so the folder
   is at `models/vosk-model-small-en-us-0.15` next to `stt_worker.py` (`VOSK_MODEL=<path>`
   overrides).
4. Create a `.env` (vars in Settings below).
5. Start the pool; `run.bat debug` on Windows for full per-request logs:

```
$ node pool-server.mjs
PS> .\run.bat
```

The pool launches its own Chromes. Linux works too: use real Google Chrome; the pool adds
`--no-sandbox` and wraps non-headless Chrome in `xvfb-run` automatically.

## API

### GET /token

Solve a sitekey, get a token back. Query params:

| Field | Required | Description |
|-------|----------|-------------|
| sitekey | yes | reCAPTCHA sitekey |
| target | yes | Target page URL (the origin the sitekey is registered to) |
| enterprise | no | `1` = v2-Enterprise (enterprise.js + grecaptcha.enterprise) |

A `POST` with a JSON body `{"sitekey","target","enterprise"}` works too (or `X-Sitekey` /
`X-Target` headers).

Response fields:

- `elapsed` - solve wall time, ms
- `token` - the `g-recaptcha-response`, ready to submit
- errors: 400 missing sitekey/target, 500 solve failed - as `{"error":"...","ms":...}`

### GET /health

Returns pool state: `{"ok","globalBrowsers","fleets"}` (browsers + tabs per fleet).

### GET /stats

Counters (`requests`, `ok`, `fail`, `retries`, `recycles`, ...) plus `blocks` = audio-block count,
`avgMs`, and per-browser detail.

### Proxy

Off by default - the pool runs on the box IP. `USE_PROXIES=on` gives each browser its own egress
IP, round-robin from `PROXIES` (comma/newline list) or a `proxies.txt` file in the CWD. Formats:
`host:port` | `user:pass@host:port` | `scheme://user:pass@host:port` | `host:port:user:pass`.
Each browser binds its IP via `--proxy-server` and rotates on recycle - an audio block recycles
the browser, so a blocked IP rotates away automatically. `PER_TAB_PROXY=1` gives every tab its
own IP instead of every browser.

## How it works

The target's document is intercepted via CDP `Fetch` and replaced with a one-line page hosting
only the `g-recaptcha` div + `api.js` - the browser's origin is the target's (the token is valid
for it), but the target server is never contacted. The anchor and bframe are cross-origin
google.com OOPIFs, each driven through its own CDP session. Per solve: click the checkbox, switch
to audio, download the mp3, transcribe it offline (vosk first, Google fallback) in a persistent
Python worker pool, type the answer, verify. A rotating fresh-profile fleet serves each
(sitekey, target); tabs solve warm, recycling the profile every N solves.

## Settings

Set via environment or a `.env` file (real env vars take precedence).

| Var | Default | Description |
|-----|---------|-------------|
| PORT | 4400 | HTTP port (/token, /health, /stats) |
| BROWSERS | 3 | Chrome browsers per fleet (~= vCPU count) |
| TABS | 2 no-proxy / 1 with proxies | V2Sessions per browser (measured sweet spot) |
| USE_PROXIES | off | `on` loads your proxy list; `off` runs on the box IP |
| PROXIES | - | Comma/newline separated list, or a `proxies.txt` file (only when USE_PROXIES=on) |
| STT / STT_WORKERS | auto / 2 | Engine + persistent Python workers; `auto` = vosk first, Google fallback. Also `vosk`, `google`, `whisper`, `whispercpp`, `wit`, `deepgram` |
| RECYCLE_AFTER_SOLVES | 6 no-proxy / 12 with proxies | Fresh profile (+ new proxy) after N solves |
| HEADLESS | 0 | `0`/unset = visible window; `1` = true headless, works for v2 but the Headless UA raises the audio-block rate |
| DEBUG | 0 | `1` = full per-request pipeline logs |

Every other knob has a sane default - see the top of `pool-server.mjs`.

## Scaling

All numbers owner-measured, Sep 2026.

| Rig | Load | Avg | Result |
|-----|------|-----|--------|
| 24-core VPS, vosk-small | 12 browsers x 2 tabs (C=24) | - | 281 CPM peak, 99% success, loadavg 9, ~14 GB |
| clean IP | concurrency 8 | 2.9s warm | ~232 CPM, sustains ~100-150 CPM |
| 16 proxy IPs | 16 browsers x 1 tab | - | ~123 CPM, 99% success |
| 4 Chromes, PER_TAB_PROXY | 4x4 tabs (16 IPs) | - | ~89 CPM, 100% |

vosk STT costs ~1 core per worker, so set `STT_WORKERS` ~= concurrency. Throughput scales with
boxes and IPs. **Verdict: ~2.9 s per solve warm, and CPM scales with cores and clean IPs.**

Test it yourself: `PORT=4400 C=8 DUR=60000 node cpm.mjs` (`C` = concurrent workers, default 6;
`DUR` = window in ms, default 30000; optional `SITEKEY`/`TARGET`). It prints a live
`[30s] CPM=.. ok=.. fail=..` tick every 3 s, then `CPM = N` and `latency avg/p50/p90 ms`.

## The ceiling

- Audio route only; image challenges are out of scope. The widget must expose a reachable audio
  challenge.
- Mints v2 checkbox tokens, valid for v2 and v2 Enterprise. No scores - not a v3 action token.
- A worked IP gets audio-blocked over time. Fresh profiles dodge it for a while; flagged IPs need
  proxies (`USE_PROXIES=on`).
- `HEADLESS=1` works, but the Headless UA raises the audio-block rate - a visible window is the
  safer default.

## License

MIT. See LICENSE.
