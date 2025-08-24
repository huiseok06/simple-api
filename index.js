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
// 아래 전체 함수로 교체
const DEFAULT_VOICE = process.env.TOPMEDIA_VOICE || 'ko_female_basic';

function runPythonAnalyze({ videoPath, outDir, voiceId }) {
  const resultPath = path.join(outDir, 'result.json');

  async function readJsonWithRetry(p, tries = 12, delayMs = 300) {
    for (let i = 0; i < tries; i++) {
      try {
        const txt = await fs.readFile(p, 'utf-8');
        if (txt && txt.trim().length > 0) {
          const j = JSON.parse(txt);
          return j;
        }
      } catch (e) {
        // ignore
      }
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
        voiceId || DEFAULT_VOICE,
      ],
      { env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));

    py.on('close', async (code) => {
      try {
        // 1) 가장 신뢰도 높은 경로: 파일을 읽는다(재시도 포함)
        const j = await readJsonWithRetry(resultPath);

        // 2) 파이썬이 에러 JSON을 남긴 경우
        if (j && j.status === 'error') {
          const msg = `${j.message || 'python error'} :: ${String(j.trace || '').slice(0, 400)}`;
          return reject(new Error(msg));
        }

        // 3) 정상 결과
        return resolve(j);
      } catch (e) {
        // 파일이 없거나 비었을 때: stdout/stderr로 힌트 제공
        const snippet = (out || err || '').toString().slice(0, 800);
        return reject(new Error(`invalid JSON from python: ${e}\n---\n${snippet}`));
      }
    });
  });
}
