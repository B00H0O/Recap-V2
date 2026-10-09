// Terminal UI for the pool - pure ANSI.
//   normal : embedded banner + subtitle + clean endpoint URL, then `[HH:MM:SS] | Wn | elapsed | token`
//            (token fills the full terminal width; green ok / red fail). NO config line, NO "ready" line.
//   debug  : adds the config line + "DEBUG MODE", and the FULL per-request pipeline
//            RECV -> ACQUIRE -> SOLVE (every internal step from solve-v2) -> TOKEN -> SEND.
// Banner is EMBEDDED (base64 below - no external banner.txt). To change the art: base64-encode the new
// figlet and replace ART_B64 (or paste lines into ART and drop the decode).
const A = {
  reset: '\x1b[0m', boldCyan: '\x1b[1;36m', dim: '\x1b[2m', gray: '\x1b[90m',
  cyan: '\x1b[96m', green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m',
  magenta: '\x1b[95m', blue: '\x1b[94m', white: '\x1b[37m',
};
const ART_B64 = 'IF9fX18gICAgICAgICAgICAgICAgICAgICAgXyAgICAgICBfICAgICAgICAgICAgX18gICAgIF9fX19fXwp8ICBfIFwgX19fICBfX18gX18gXyBfIF9fIHwgfF8gX19ffCB8X18gICBfXyBfICBcIFwgICAvIC9fX18gXAp8IHxfKSAvIF8gXC8gX18vIF9gIHwgJ18gXHwgX18vIF9ffCAnXyBcIC8gX2AgfCAgXCBcIC8gLyAgX18pIHwKfCAgXyA8ICBfXy8gKF98IChffCB8IHxfKSB8IHx8IChfX3wgfCB8IHwgKF98IHwgICBcIFYgLyAgLyBfXy8KfF98IFxfXF9fX3xcX19fXF9fLF98IC5fXy8gXF9fXF9fX3xffCB8X3xcX18sX3wgICAgXF8vICB8X19fX198CiAgICAgICAgICAgICAgICAgICAgfF98';
const ART = Buffer.from(ART_B64, 'base64').toString('utf8').split('\n');
const SUBTITLE = 'Recaptcha V2 Solver  |  By @B00H0  |  t.me/HK407';

const width = () => process.stdout.columns || 100;
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, w) => { const n = vlen(s); return n >= w ? 0 : Math.floor((w - n) / 2); };
const centerPlain = (s, w) => ' '.repeat(pad(s, w)) + s;
const center = (s, color, w) => ' '.repeat(pad(s, w)) + color + s + A.reset;
const padc = (s, w) => { const n = vlen(s); if (n >= w) return s; const l = Math.floor((w - n) / 2); return ' '.repeat(l) + s + ' '.repeat(w - n - l); };   // CENTER content in a cell (`W1` -> ` W1 `, even spacing both sides)
const hms = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const ms3 = () => { const d = new Date(); return `${hms()}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

export function printBanner({ port, cfg = '', debug = false } = {}) {
  const w = width();
  let out = '\x1b[2J\x1b[H\n';
  const artW = Math.max(...ART.map((l) => l.length));       // BLOCK-center the figlet: one shared indent for ALL lines preserves the art's internal alignment (centering each line on its own drifts short lines like `|_|`)
  const lead = ' '.repeat(Math.max(0, Math.floor((w - artW) / 2)));
  for (const line of ART) out += lead + A.boldCyan + line + A.reset + '\n';
  out += '\n' + center(SUBTITLE, A.boldCyan, w) + '\n\n';
  if (debug) {                                              // config + DEBUG label show ONLY in debug mode
    if (cfg) out += center(cfg, A.blue, w) + '\n\n';        // config line, then a blank line
    out += center('DEBUG MODE', A.magenta, w) + '\n';
  }
  const url = `http://localhost:${port}/token`;             // clean endpoint URL, rule sized to it
  out += centerPlain(url, w) + '\n';                        // (single blank line before the URL - no extra \n)
  out += center('-'.repeat(Math.min(vlen(url), w)), A.dim, w) + '\n\n';
  process.stdout.write(out);
}

export function ready() {}                                  // intentionally empty (no "Ready - waiting..." line)

let _ids = 0;
export const nextId = () => ++_ids;

// debug-only pipeline step (no-op in normal mode). Even columns, `|` separators:
//   [HH:MM:SS.mmm] | #id | Wn | TAG     | message
export function step(debug, id, label, tag, msg = '') {
  if (!debug) return;
  const colors = { RECV: A.cyan, ACQUIRE: A.blue, SOLVE: A.yellow, TOKEN: A.green, SEND: A.magenta, RETRY: A.yellow, RELOAD: A.yellow };
  const c = colors[tag] || A.gray;
  const s = `${A.dim}|${A.reset}`;
  console.log(`  ${A.blue}[${ms3()}]${A.reset} ${s} ${A.dim}${padc('#' + id, 2)}${A.reset} ${s} ${A.cyan}${padc(label || '', 2)}${A.reset} ${s} ${c}${tag.padEnd(7)}${A.reset} ${s} ${msg}`);
}

// short token preview: a 54-char prefix + "..." (enough to eyeball the token, keeps the line tidy)
const shortTok = (t) => { const s = String(t); return s.length <= 54 ? s : s.slice(0, 54) + '...'; };

// final per-request line - normal: `[HH:MM:SS] | Wn | elapsed | token(full-width)`
export function result({ debug, id, label, ok, ms, token = '', err = '' }) {
  if (debug) {
    const c = ok ? A.green : A.red; const s = `${A.dim}|${A.reset}`;
    console.log(`  ${A.blue}[${ms3()}]${A.reset} ${s} ${A.dim}${padc('#' + id, 2)}${A.reset} ${s} ${A.cyan}${padc('', 2)}${A.reset} ${s} ${A.magenta}${'SEND'.padEnd(7)}${A.reset} ${s} ${c}${ok ? 'OK' : 'FAIL'}${A.reset} ${A.dim}in${A.reset} ${A.yellow}${ms}ms${A.reset}${ok ? '' : '  ' + A.red + err + A.reset}`);
    console.log('');                                          // blank line: separate this request's block from the next (debug only)
    return;
  }
  const sep = `${A.dim}|${A.reset}`;                        // normal line: `[HH:MM:SS] | elapsed | token` - blue time, NO worker label
  if (ok) console.log(`  ${A.blue}[${hms()}]${A.reset} ${sep} ${A.yellow}${padc(ms + 'ms', 7)}${A.reset} ${sep} ${A.green}${shortTok(token)}${A.reset}`);
  else console.log(`  ${A.blue}[${hms()}]${A.reset} ${sep} ${A.yellow}${padc(ms + 'ms', 7)}${A.reset} ${sep} ${A.red}${err}${A.reset}`);
}
