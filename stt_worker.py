#!/usr/bin/env python3
# Persistent STT worker: loads the vosk model ONCE, then serves many transcriptions over a
# JSON-lines stdin/stdout protocol (saves the ~0.5-1s model-load + python-spawn per call).
# In:  {"id":N,"url":"<audio mp3 url>"}   Out: {"id":N,"text":"<transcript>"}
# vosk first (offline, fast, scalable) with Google fallback; spoken-number normalization.
import sys, os, io, re, json, wave, subprocess, urllib.request

PROVIDER = os.environ.get('STT', 'auto').lower()  # auto(vosk->google) | vosk | google | whisper | whispercpp | wit | deepgram(cloud, set DEEPGRAM_API_KEY)
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'base.en')  # faster-whisper model: tiny.en|base.en|small.en|medium.en
WHISPER_THREADS = int(os.environ.get('WHISPER_THREADS', '4'))
_here = os.path.dirname(os.path.abspath(__file__))
def _find_model():
    # Resolution: env override first, then the project-local models/ folder.
    cands = [
        os.environ.get('VOSK_MODEL'),
        os.path.join(_here, 'models', 'vosk-model-small-en-us-0.15'),
    ]
    for c in cands:
        if c and os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.abspath(os.environ.get('VOSK_MODEL') or cands[1])  # clear "not found" error on the best guess
MODEL_PATH = _find_model()

# MEASURED (2captcha v2 demo): reCAPTCHA v2 audio is a spoken PHRASE ("vice within them where the"), NOT digits
# - unconstrained vosk transcribes it and solves on the first try. A digit grammar emits "[unk]" for phrase audio
# (a wrong answer), so it's OFF by default and only useful for the rare digit-audio site. Left available + made
# safe (the [unk] marker is stripped and we fall back to unconstrained) in case a target does use digit audio.
DIGIT_GRAMMAR = '["zero oh one two three four five six seven eight nine", "[unk]"]'
USE_GRAMMAR = os.environ.get('STT_GRAMMAR', '0') == '1'  # default OFF

_WORDS = {'zero':'0','oh':'0','one':'1','two':'2','three':'3','four':'4','five':'5','six':'6','seven':'7','eight':'8','nine':'9'}
def normalize(t):
    t = (t or '').lower().strip()
    if not t: return ''
    t = re.sub(r'[^\w\s]', ' ', t)               # strip punctuation (whisper adds commas/periods that reCAPTCHA rejects)
    toks = [_WORDS.get(w, w) for w in re.split(r'\s+', t) if w]
    out = ' '.join(toks)
    out = re.sub(r'(?<=\d)\s+(?=\d)', '', out)   # "3 7 2 4" -> "3724"
    return out.strip()

_ff = None
def ffmpeg_exe():
    global _ff
    if _ff is None:
        if os.environ.get('FFMPEG'):
            _ff = os.environ['FFMPEG']                       # explicit override
        else:
            try:
                import imageio_ffmpeg; _ff = imageio_ffmpeg.get_ffmpeg_exe()  # bundled static ffmpeg if the pip pkg is present
            except Exception:
                _ff = 'ffmpeg'                               # else system ffmpeg on PATH (e.g. apt install ffmpeg) - needed by the vosk/whisper paths
    return _ff

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.google.com/'})
    return urllib.request.urlopen(req, timeout=10).read()   # mp3 is downloaded direct from Google (not via proxy) - fast; 10s is a safety cap (was 20)

def to_wav(mp3):
    p = subprocess.run([ffmpeg_exe(), '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
                       input=mp3, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return p.stdout

_model = None
def model():
    global _model
    if _model is None:
        from vosk import Model
        _model = Model(MODEL_PATH)
    return _model

def via_vosk(wav, grammar=None):
    from vosk import KaldiRecognizer
    wf = wave.open(io.BytesIO(wav), 'rb')
    rec = KaldiRecognizer(model(), wf.getframerate(), grammar) if grammar else KaldiRecognizer(model(), wf.getframerate())
    out = []
    while True:
        d = wf.readframes(4000)
        if not d: break
        if rec.AcceptWaveform(d): out.append(json.loads(rec.Result()).get('text', ''))
    out.append(json.loads(rec.FinalResult()).get('text', ''))
    return ' '.join(w for w in out if w).strip()

def via_google(wav):
    import speech_recognition as sr  # type: ignore  (optional engine for STT=google; install: pip install SpeechRecognition)
    r = sr.Recognizer()
    with sr.AudioFile(io.BytesIO(wav)) as s: a = r.record(s)
    return r.recognize_google(a)

def via_deepgram(mp3):                                   # Deepgram prerecorded REST (CLOUD, offloads CPU). Set DEEPGRAM_API_KEY [+ DEEPGRAM_MODEL].
    key = os.environ.get('DEEPGRAM_API_KEY') or ''       # sends the mp3 bytes directly (no ffmpeg) - Deepgram decodes mp3 itself.
    mdl = os.environ.get('DEEPGRAM_MODEL', 'nova-3')
    url = 'https://api.deepgram.com/v1/listen?model=%s&language=en&punctuate=false&smart_format=false' % mdl
    req = urllib.request.Request(url, data=mp3, headers={'Authorization': 'Token ' + key, 'Content-Type': 'audio/mpeg'})
    resp = urllib.request.urlopen(req, timeout=12).read().decode('utf-8', 'ignore')  # Deepgram is ~3s; 12s safety cap (was 20)
    j = json.loads(resp)
    return j.get('results', {}).get('channels', [{}])[0].get('alternatives', [{}])[0].get('transcript', '')

def via_deepgram_url(audio_url):                         # hand Deepgram the audio URL - Deepgram fetches it (no download/ffmpeg on our side)
    key = os.environ.get('DEEPGRAM_API_KEY') or ''
    mdl = os.environ.get('DEEPGRAM_MODEL', 'nova-3')
    api = 'https://api.deepgram.com/v1/listen?model=%s&language=en&punctuate=false&smart_format=false' % mdl
    body = json.dumps({'url': audio_url}).encode()
    req = urllib.request.Request(api, data=body, headers={'Authorization': 'Token ' + key, 'Content-Type': 'application/json'})
    resp = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore')
    j = json.loads(resp)
    return j.get('results', {}).get('channels', [{}])[0].get('alternatives', [{}])[0].get('transcript', '')

def via_wit(wav):                                        # Wit.ai (Meta) - free token from wit.ai, set WIT_API_KEY / WIT_AI_TOKEN
    tok = os.environ.get('WIT_API_KEY') or os.environ.get('WIT_AI_TOKEN') or ''
    req = urllib.request.Request('https://api.wit.ai/speech?v=20230215', data=wav, headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'audio/wav'})
    resp = urllib.request.urlopen(req, timeout=25).read().decode('utf-8', 'ignore')
    ms = re.findall(r'"text"\s*:\s*"([^"]*)"', resp)     # wit streams partial JSON objects; last "text" = final
    return ms[-1] if ms else ''

_whisper = None
def whisper_model():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel  # type: ignore  (optional engine; install: pip install faster-whisper)
        _whisper = WhisperModel(WHISPER_MODEL, device='cpu', compute_type='int8', cpu_threads=WHISPER_THREADS)
    return _whisper
def via_whisper(wav):
    import tempfile
    m = whisper_model()
    f = tempfile.NamedTemporaryFile(suffix='.wav', delete=False); f.write(wav); f.close()
    try:
        segs, _ = m.transcribe(f.name, language='en', beam_size=1)
        return ' '.join(s.text for s in segs).strip()
    finally:
        try: os.remove(f.name)
        except Exception: pass

_wcpp = None
def wcpp_model():
    global _wcpp
    if _wcpp is None:
        from pywhispercpp.model import Model  # type: ignore  (optional engine; install: pip install pywhispercpp)
        _wcpp = Model(WHISPER_MODEL, n_threads=WHISPER_THREADS, print_realtime=False, print_progress=False, redirect_whispercpp_logs_to=False)
    return _wcpp
def via_whispercpp(wav):                                  # whisper.cpp: whisper accuracy at ~4 cores (vs faster-whisper's ~8)
    import tempfile
    m = wcpp_model()
    f = tempfile.NamedTemporaryFile(suffix='.wav', delete=False); f.write(wav); f.close()
    try:
        return ' '.join(s.text for s in m.transcribe(f.name)).strip()
    finally:
        try: os.remove(f.name)
        except Exception: pass


def transcribe(url):
    forced = os.environ.get('STT_FORCE')          # test hook: force a fixed answer (e.g. a wrong phrase) without real audio
    if forced is not None:
        return normalize(forced)
    if PROVIDER == 'deepgram':                             # CLOUD: no ffmpeg; URL mode (DEEPGRAM_USE_URL=1) also skips OUR download
        text = ''
        try:
            if os.environ.get('DEEPGRAM_USE_URL', '') in ('1', 'true', 'on', 'yes'):
                text = via_deepgram_url(url)               # [!] MEASURED 2026-06: does NOT work for reCAPTCHA - Deepgram's fetcher can't pull the audio URL (needs our UA+referer) -> empty transcript. Keep default (bytes).
            else:
                text = via_deepgram(fetch(url))            # we download the mp3 + send bytes (we control the fetch = robust)
        except Exception as e: sys.stderr.write('deepgram: %s\n' % e)
        return normalize(text)
    raw = fetch(url)
    _sd = os.environ.get('STT_SAVE_DIR')                  # debug/benchmark: dump every fetched mp3 (before transcribe)
    if _sd:
        try:
            import hashlib; os.makedirs(_sd, exist_ok=True)
            open(os.path.join(_sd, hashlib.md5(raw).hexdigest()[:10] + '.mp3'), 'wb').write(raw)
        except Exception: pass
    wav = to_wav(raw)
    text = ''
    if PROVIDER == 'whisper':
        try: text = via_whisper(wav)
        except Exception as e: sys.stderr.write('whisper: %s\n' % e)
    elif PROVIDER == 'whispercpp':
        try: text = via_whispercpp(wav)
        except Exception as e: sys.stderr.write('whispercpp: %s\n' % e)
    elif PROVIDER == 'wit':
        try: text = via_wit(wav)
        except Exception as e: sys.stderr.write('wit: %s\n' % e)
    elif PROVIDER == 'google':
        try: text = via_google(wav)
        except Exception as e: sys.stderr.write('google: %s\n' % e)
    else:                                                  # auto | vosk
        try:
            if USE_GRAMMAR:
                g = re.sub(r'\[unk\]', '', via_vosk(wav, DIGIT_GRAMMAR)).strip()  # strip the unknown-token marker
                text = g if normalize(g) else via_vosk(wav)   # grammar empty/only-[unk] -> unconstrained fallback
            else:
                text = via_vosk(wav)
        except Exception as e:
            sys.stderr.write('vosk: %s\n' % e)
            try: text = via_vosk(wav)                      # if the grammar ctor isn't supported, plain vosk
            except Exception as e2: sys.stderr.write('vosk2: %s\n' % e2)
        if not text and PROVIDER == 'auto':
            try: text = via_google(wav)
            except Exception as e: sys.stderr.write('google: %s\n' % e)
    return normalize(text)

def main():
    try:
        if PROVIDER == 'whisper': whisper_model()         # warm the model so the first request is fast
        elif PROVIDER == 'whispercpp': wcpp_model()
        elif PROVIDER in ('auto', 'vosk'): model()
    except Exception as e: sys.stderr.write('warm: %s\n' % e)
    sys.stdout.write(json.dumps({"ready": True}) + "\n"); sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            sys.stdout.write(json.dumps({"id": req.get('id'), "text": transcribe(req['url'])}) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"id": None, "text": "", "err": str(e)}) + "\n")
        sys.stdout.flush()

if __name__ == '__main__':
    main()
