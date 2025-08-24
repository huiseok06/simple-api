// index.js — 통째로 교체
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { spawn } from 'node:child_process';

// 0) 런타임 에러를 로그에 남기고 종료 원인을 드러내기
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

// //upload 같은 경로도 /upload로 정규화(클라이언트 실수 방지)
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// ensure folders (동기 버전으로 변경: top-level await 회피)
fs.ensureDirSync(DATA_DIR);
const jobDir = (id) => path.join(DATA_DIR, id);
const toUrl = (absPath) => {
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  return `${PUBLIC_BASE_URL}/files/${rel}`;
};

// serve static files
app.use('/files', express.static(DATA_DIR));

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

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

    py.on('close', async (code) => {
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

// ---------- upload route ----------
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const id = crypto.randomBytes(6).toString('hex') + '-' + Date.now().toString(36);
      req.uploadId = id;
      const dir = jobDir(id);
      await fs.ensureDir(dir);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => cb(null, 'video.mp4')
});
const upload = multer({ storage });

// POST /upload  (multipart/form-data; fields: video, [voiceId])
app.post('/upload', upload.single('video'), async (req, r
