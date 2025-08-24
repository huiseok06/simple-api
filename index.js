// index.js — SIMPLE-API 서버 (통째로 교체)
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { spawn } from 'node:child_process';

// 전역 에러 로깅
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED', err);
  process.exit(1);
});
console.log('Booting SIMPLE-API with Node', process.version, 'PORT=', process.env.PORT);

const app = express();
app.use(cors());
app.use(express.json());

// //upload 같은 2중 슬래시 정리
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 디렉터리 준비(동기)
fs.ensureDirSync(DATA_DIR);
const jobDir = (id) => path.join(DATA_DIR, id);
const toUrl = (absPath) => {
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  return `${PUBLIC_BASE_URL}/files/${rel}`;
};

// 정적 파일 서빙
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
        if (txt && txt.trim().length > 0) {
          return JSON.parse(txt);
        }
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
        '--video',
        videoPath,
        '--outdir',
        outDir,
        '--fps',
        '1',
        '--max_gap',
        '10',
        '--model',
        'gemini-1.5-pro-latest',
        '--voiceId',
        voiceId || DEFAULT_VOICE
      ],
      { env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));

    py.on('close', async (_code) => {
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

// ---------- 업로드 라우트 ----------
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = crypto.randomBytes(6).toString('hex') + '-' + Date.now().toString(36);
    req.uploadId = id;
    const dir = jobDir(id);
    fs.ensureDir(dir).then(() => cb(null, dir)).catch(cb);
  },
  filename: (_req, file, cb) => cb(null, 'video.mp4')
});
const upload = multer({ storage });

// POST /upload  (multipart/form-data; fields: video, [voiceId])
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
