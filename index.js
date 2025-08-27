// simple-api/index.js — 통째로 교체본
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { spawn } from 'node:child_process';

process.on('uncaughtException', (err) => { console.error('UNCAUGHT', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED', err); process.exit(1); });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => { req.url = req.url.replace(/\/{2,}/g, '/'); next(); });

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DEFAULT_VOICE = process.env.TOPMEDIA_VOICE || 'ko_female_basic';

fs.ensureDirSync(DATA_DIR);
const jobDir = (id) => path.join(DATA_DIR, id);
const toUrl = (absPath) => {
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  return `${PUBLIC_BASE_URL}/files/${rel}`;
};

app.use('/files', express.static(DATA_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// 업로드 스토리지
const storage = multer.diskStorage({
  destination(_req, _file, cb) { fs.ensureDirSync(DATA_DIR); cb(null, DATA_DIR); },
  filename(_req, file, cb) {
    const name = file.originalname?.replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'video.mp4';
    cb(null, `${Date.now()}_${name}`);
  }
});
const upload = multer({ storage });

// ---------- Python runner ----------
function readJsonWithRetry(p, tries = 20, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = async () => {
      try {
        const txt = await fs.readFile(p, 'utf-8');
        if (txt && txt.trim().length > 0) return resolve(JSON.parse(txt));
      } catch {}
      if (++i >= tries) return reject(new Error('result.json missing or empty after retries'));
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

function runPythonAnalyze({ videoPath, outDir, voiceId, fast }) {
  return new Promise((resolve, reject) => {
    const pyArgs = [
      'analysis_service.py',
      '--video', videoPath,
      '--outdir', outDir,
      '--voiceId', voiceId || DEFAULT_VOICE,
      ...(fast ? ['--fps','0','--model','gemini-1.5-flash'] : ['--fps','1','--model','gemini-1.5-pro-latest'])
    ];

    const py = spawn('python3', pyArgs, { cwd: process.cwd(), env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));
    py.on('close', async (code) => {
      try {
        const resultPath = path.join(outDir, 'result.json');
        const j = await readJsonWithRetry(resultPath);
        if (j && j.status === 'error') return reject(new Error(j.message || 'python error'));
        resolve(j);
      } catch (e) {
        console.error('analyze read error:', e, '\npyOut=', out, '\npyErr=', err);
        reject(e);
      }
    });
  });
}

function runPythonResynthesize({ outDir, voiceId, linesPath }) {
  return new Promise((resolve, reject) => {
    const pyArgs = [
      'analysis_service.py',
      '--outdir', outDir,
      '--voiceId', voiceId || DEFAULT_VOICE,
      '--lines_path', linesPath,
    ];

    const py = spawn('python3', pyArgs, { cwd: process.cwd(), env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));
    py.on('close', async (_code) => {
      try {
        const resultPath = path.join(outDir, 'result.json');
        const j = await readJsonWithRetry(resultPath);
        if (j && j.status === 'error') return reject(new Error(j.message || 'python error'));
        resolve(j);
      } catch (e) {
        console.error('resynthesize read error:', e, '\npyOut=', out, '\npyErr=', err);
        reject(e);
      }
    });
  });
}

// 1) 업로드만
app.post('/upload-only', upload.single('video'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) throw new Error('no video');

    const id = crypto.randomBytes(8).toString('hex');
    const dir = jobDir(id);
    await fs.ensureDir(dir);
    const videoPath = path.join(dir, 'video.mp4');
    await fs.move(file.path, videoPath, { overwrite: true });

    return res.json({
      jobId: id,
      videoUrl: toUrl(videoPath),
      status: 'uploaded'
    });
  } catch (e) {
    console.error('upload-only failed', e);
    res.status(500).json({ error: 'upload-only failed', detail: String(e?.message || e) });
  }
});

// 2) 분석 + TTS
app.post('/analyze', async (req, res) => {
  try {
    const { jobId, voiceId, fast } = req.body || {};
    if (!jobId) throw new Error('jobId required');
    const dir = jobDir(jobId);
    const videoPath = path.join(dir, 'video.mp4');
    if (!(await fs.pathExists(videoPath))) throw new Error('video not found for jobId');

    const result = await runPythonAnalyze({ videoPath, outDir: dir, voiceId, fast: String(fast) === '1' });

    return res.json({
      jobId,
      videoUrl: toUrl(videoPath),
      ttsUrl: toUrl(result.tts_path),
      script: result.script,
      lines: result.lines,
      timeline: result.timeline,
      durationSec: result.duration_sec,
      status: 'ready'
    });
  } catch (e) {
    console.error('analyze failed', e);
    res.status(500).json({ error: 'analyze failed', detail: String(e?.message || e) });
  }
});

// 3) TTS만 재생성(대본/보이스 변경)
app.post('/resynthesize', async (req, res) => {
  try {
    const { jobId, voiceId, lines, script } = req.body || {};
    if (!jobId) throw new Error('jobId required');
    const dir = jobDir(jobId);
    const videoPath = path.join(dir, 'video.mp4');
    if (!(await fs.pathExists(videoPath))) throw new Error('video not found for jobId');

    // 기존 result.json에서 lines 기본값 확보
    let base = null;
    const resultPath = path.join(dir, 'result.json');
    if (await fs.pathExists(resultPath)) {
      try { base = JSON.parse(await fs.readFile(resultPath, 'utf-8')); } catch {}
    }
    let newLines = Array.isArray(lines) && lines.length
      ? lines
      : (base && Array.isArray(base.lines) ? base.lines : []);

    // script 문자열이 오면 줄바꿈 기준으로 기존 start와 매핑
    if (typeof script === 'string' && newLines.length) {
      const parts = script.split(/\r?\n/).filter(s => s.trim().length > 0);
      const L = Math.min(parts.length, newLines.length);
      newLines = newLines.map((ln, i) => (i < L ? { ...ln, text: parts[i] } : ln));
    }

    const linesPath = path.join(dir, 'lines_override.json');
    await fs.writeFile(linesPath, JSON.stringify(newLines), 'utf-8');

    const result = await runPythonResynthesize({ outDir: dir, voiceId, linesPath });

    return res.json({
      jobId,
      videoUrl: toUrl(videoPath),
      ttsUrl: toUrl(result.tts_path),
      script: (result && result.script) || (base && base.script) || '',
      lines: newLines,
      timeline: result.timeline,
      durationSec: result.duration_sec,
      status: 'ready'
    });
  } catch (e) {
    console.error('resynthesize failed', e);
    res.status(500).json({ error: 'resynthesize failed', detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`SIMPLE-API listening on ${PORT}`);
  console.log(`Static files at ${PUBLIC_BASE_URL}/files/...`);
});