import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { spawn } from 'node:child_process';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// ensure folders
await fs.ensureDir(DATA_DIR);
const jobDir = (id) => path.join(DATA_DIR, id);
const ensureDir = (p) => fs.ensureDir(p);
const toUrl = (absPath) => {
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  return `${PUBLIC_BASE_URL}/files/${rel}`;
};

// serve static files (video/mp3 results)
app.use('/files', express.static(DATA_DIR));

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- Python analyzer runner ----------
// ---------- Python analyzer runner ----------
// 아래 전체 함수로 교체
const DEFAULT_VOICE = process.env.TOPMEDIA_VOICE || 'ko_female_basic';

function runPythonAnalyze({ videoPath, outDir, voiceId }) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [
      'analyzer/analysis_service.py',
      '--video', videoPath,
      '--outdir', outDir,
      '--fps', '1',
      '--max_gap', '10',
      '--model', 'gemini-1.5-pro-latest',
      '--voiceId', voiceId || DEFAULT_VOICE
    ], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }, // ← 무버퍼
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    py.stdout.on('data', d => (out += d.toString()));
    py.stderr.on('data', d => (err += d.toString()));

    py.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(err || `python exited ${code}`));
      }
      try {
        // stdout이 비었으면 파일 fallback
        if (!out.trim()) {
          const jf = path.join(outDir, 'result.json');
          const txt = await fs.readFile(jf, 'utf-8');
          return resolve(JSON.parse(txt));
        }
        return resolve(JSON.parse(out));
      } catch (e) {
        const snippet = (out || err || '').toString().slice(0, 800);
        return reject(new Error(`invalid JSON from python: ${e}\n---\n${snippet}`));
      }
    });
  });
}
