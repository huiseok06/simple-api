// SIMPLE-API/index.js — 서버 메인
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { spawn } from 'node:child_process';

process.on('uncaughtException', (err) => { console.error('UNCAUGHT', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED', err); process.exit(1); });
console.log('Booting SIMPLE-API with Node', process.version, 'PORT=', process.env.PORT);

const app = express();
app.use(cors());
app.use(express.json());

// //upload 같은 2중 슬래시 정리
app.use((req, _res, next) => { req.url = req.url.replace(/\/{2,}/g, '/'); next(); });

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

fs.ensureDirSync(DATA_DIR);
const jobDir = (id) => path.join(DATA_DIR, id);
const toUrl = (absPath) => {
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  return `${PUBLIC_BASE_URL}/files/${rel}`;
};

app.use('/files', express.static(DATA_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- Python analyzer runner ----------
const DEFAULT_VOICE = process.env.TOPMEDIA_VOICE || 'ko_female_basic';

function runPythonAnalyze({ videoPath, outDir, voiceId }) {
  const resultPath = path.join(outDir, 'result.json');

  async function readJsonWithRetry(p, tries = 12, delayMs = 300) {
    for (let i = 0; i < tries; i++) {
      try {
        const txt = await fs.readFile(p, 'utf-8');
        if (txt && txt.trim().length > 0) return JSON.parse(txt);
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('result.json missing or empty after retries');
  }

  return new Promise((resolve, reject) => {
    const py = spawn(
      'python3',
      [
        'analyzer/analysis_service.py',
        ...(videoPath ? ['--video', videoPath] : []),
        '--outdir', outDir,
        '--fps', '1',
        '--max_gap', '10',
        '--model', 'gemini-1.5-pro-latest',
        '--voiceId', voiceId || DEFAULT_VOICE
      ],
      { env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '', err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));

    py.on('close', async () => {
      try {
        const j = await readJsonWithRetry(resultPath);
        if (j && j.status === 'error') {
          const msg = `${j.message || 'python error'} :: ${String(j.trace || '').slice(0, 400)}`;
          return reject(new Error(msg));
        }
        return resolve(j);
      } catch (e) {
        const snippet = (out || err || '').toString().slice(0, 800);
        return reject(new Error(`invalid JSON from python: ${e}\n---\n${snippet}`));
      }
    });
  });
}

function runPythonResynthesize({ outDir, voiceId, linesPath }) {
  const resultPath = path.join(outDir, 'result.json');

  async function readJsonWithRetry(p, tries = 12, delayMs = 300) {
    for (let i = 0; i < tries; i++) {
      try {
        const txt = await fs.readFile(p, 'utf-8');
        if (txt && txt.trim().length > 0) return JSON.parse(txt);
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('result.json missing or empty after retries');
  }

  return new Promise((resolve, reject) => {
    const py = spawn(
      'python3',
      [
        'analyzer/analysis_service.py',
        '--outdir', outDir,
        '--voiceId', voiceId || DEFAULT_VOICE,
        '--lines_path', linesPath // 분석 없이 라인 기반으로 TTS만 재생성
      ],
      { env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '', err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));

    py.on('close', async () => {
      try {
        const j = await readJsonWithRetry(resultPath);
        if (j && j.status === 'error') {
          const msg = `${j.message || 'python error'} :: ${String(j.trace || '').slice(0, 400)}`;
          return reject(new Error(msg));
        }
        return resolve(j);
      } catch (e) {
        const snippet = (out || err || '').toString().slice(0, 800);
        return reject(new Error(`invalid JSON from python: ${e}\n---\n${snippet}`));
      }
    });
  });
}

// ---------- 업로드 저장소 ----------
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = crypto.randomBytes(6).toString('hex') + '-' + Date.now().toString(36);
    req.uploadId = id;
    const dir = jobDir(id);
    fs.ensureDir(dir).then(() => cb(null, dir)).catch(cb);
  },
  filename: (_req, _file, cb) => cb(null, 'video.mp4')
});
const upload = multer({ storage });

// ---------- 라우트들 ----------

// 1) 업로드만 (분석 X)
app.post('/upload-only', upload.single('video'), async (req, res) => {
  try {
    const id = req.uploadId || crypto.randomBytes(6).toString('hex');
    const dir = jobDir(id);
    const videoPath = path.join(dir, 'video.mp4');
    if (!(await fs.pathExists(videoPath))) throw new Error('video not saved');
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
    const { jobId, voiceId } = req.body || {};
    if (!jobId) throw new Error('jobId required');
    const dir = jobDir(jobId);
    const videoPath = path.join(dir, 'video.mp4');
    if (!(await fs.pathExists(videoPath))) throw new Error('video not found for jobId');

    const result = await runPythonAnalyze({ videoPath, outDir: dir, voiceId });
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

    // 기존 lines 불러오고, 요청으로 오버라이드
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
      timeline: (base && base.timeline) || [],
      durationSec: (base && base.duration_sec) || null,
      status: 'ready'
    });
  } catch (e) {
    console.error('resynthesize failed', e);
    res.status(500).json({ error: 'resynthesize failed', detail: String(e?.message || e) });
  }
});

// (구) 업로드+분석 한방 (호환용)
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const id = req.uploadId || crypto.randomBytes(6).toString('hex');
    const dir = jobDir(id);
    const videoPath = path.join(dir, 'video.mp4');
    const voiceId =
      (req.body && req.body.voiceId) ||
      (req.query && req.query.voiceId) ||
      process.env.TOPMEDIA_VOICE;

    const result = await runPythonAnalyze({ videoPath, outDir: dir, voiceId });
    return res.json({
      jobId: id,
      videoUrl: toUrl(videoPath),
      ttsUrl: toUrl(result.tts_path),
      script: result.script,
      lines: result.lines,
      timeline: result.timeline,
      durationSec: result.duration_sec,
      status: 'ready'
    });
  } catch (e) {
    console.error('upload failed', e);
    res.status(500).json({ error: 'upload/analysis failed', detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`SIMPLE-API listening on ${PORT}`);
  console.log(`Static files at ${PUBLIC_BASE_URL}/files/...`);
});
