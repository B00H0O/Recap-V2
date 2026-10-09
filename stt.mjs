// STT bridge: a pool of PERSISTENT Python workers (stt_worker.py) that keep the vosk model warm.
// transcribe(url) dispatches to the least-busy worker over a JSON-lines protocol. Saves the
// ~0.5-1s model-load + python-spawn that a per-call process pays. Set STT_WORKERS (default 2),
// STT=auto|vosk|google|whisper|whispercpp|wit|deepgram, VOSK_MODEL=<path>.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exeDir = path.dirname(process.execPath);               // dir of the running executable; a packaged build can ship stt_worker.py + models/ next to it
const N = Math.max(1, +(process.env.STT_WORKERS || 2));
const workers = [];
let nextId = 1;

// Spawns `python stt_worker.py` (a few standard locations are probed; STT_WORKER_PY overrides the script path).
function sttCmd() {
  const py = process.env.PYTHON || 'python';
  const cands = [process.env.STT_WORKER_PY, path.join(exeDir, 'STT', 'stt_worker.py'), path.join(exeDir, 'stt_worker.py'), path.join(here, 'stt_worker.py')];
  for (const p of cands) { if (p && fs.existsSync(p)) return { cmd: py, args: [p] }; }
  return { cmd: py, args: [path.join(here, 'stt_worker.py')] };
}
function childEnv() {
  const e = { ...process.env };
  if (!e.VOSK_MODEL) { // point the worker at the model folder shipped alongside stt_worker.py
    for (const m of [path.join(exeDir, 'STT', 'models', 'vosk-model-small-en-us-0.15'), path.join(exeDir, 'models', 'vosk-model-small-en-us-0.15')]) {
      if (fs.existsSync(m)) { e.VOSK_MODEL = m; break; }
    }
  }
  return e;
}

function makeWorker() {
  const { cmd, args } = sttCmd();
  const proc = spawn(cmd, args, { env: childEnv() });
  const w = { proc, busy: 0, buf: '', inflight: new Map() };  // inflight: id -> { resolve, to } - kept PER-WORKER so a crash can reject exactly that worker's pending calls
  proc.stdout.on('data', (d) => {
    w.buf += d.toString();
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) continue;
      const e = w.inflight.get(msg.id);
      if (e) { clearTimeout(e.to); w.inflight.delete(msg.id); w.busy = Math.max(0, w.busy - 1); e.resolve(msg.text || ''); }
    }
  });
  proc.stderr.on('data', () => {});
  const reap = () => {                                       // worker gone (exit OR spawn error) -> drop it + resolve its in-flight calls NOW (empty) instead of stranding each for the 25s timeout
    w.dead = true;
    const i = workers.indexOf(w); if (i >= 0) workers.splice(i, 1);
    for (const e of w.inflight.values()) { clearTimeout(e.to); e.resolve(''); }
    w.inflight.clear(); w.busy = 0;
  };
  proc.on('exit', reap);
  proc.on('error', (e) => { try { process.stderr.write('[stt] worker spawn/runtime error: ' + (e && e.message) + '\n'); } catch {} reap(); }); // CRITICAL: a spawn failure (e.g. PYTHON not found) emits an 'error' event - without this handler Node throws it as uncaught and the WHOLE pool crashes
  return w;
}
function getWorker() {
  const idle = workers.find((w) => w.busy === 0);
  if (idle) return idle;                                   // reuse a warm idle worker
  if (workers.length < N) { const w = makeWorker(); workers.push(w); return w; } // grow lazily up to N
  let best = workers[0]; for (const w of workers) if (w.busy < best.busy) best = w;
  return best;                                              // all busy -> least-loaded
}

export function transcribe(audioUrl, log = () => {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const w = getWorker();
    const id = nextId++;
    w.busy++;
    const to = setTimeout(() => { if (w.inflight.delete(id)) { w.busy = Math.max(0, w.busy - 1); log('[stt] timeout'); resolve(''); } }, Math.max(2000, timeoutMs)); // caller (solveOnce) passes the REMAINING audio budget so a stuck STT call can't run past it; a real transcription is ~3s
    w.inflight.set(id, { resolve, to });
    try { w.proc.stdin.write(JSON.stringify({ id, url: audioUrl }) + '\n'); }
    catch (e) { clearTimeout(to); w.inflight.delete(id); w.busy = Math.max(0, w.busy - 1); log('[stt] write fail ' + e.message); resolve(''); }
  });
}

export function shutdownSTT() { for (const w of [...workers]) { try { w.proc.kill(); } catch {} } }
