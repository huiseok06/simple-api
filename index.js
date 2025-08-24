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
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    py.stdout.on('data', d => out += d.toString());
    py.stderr.on('data', d => err += d.toString());
    py.on('close', code => {
      if (code !== 0) return reject(new Error(err || `python exited ${code}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`invalid JSON from python: ${e}\n---\n${out}`)); }
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
      await ensureDir(dir);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => cb(null, 'video.mp4')
});
const upload = multer({ storage });

// POST /upload  (multipart/form-data; fields: video, [voiceId])
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const id = req.uploadId || crypto.randomBytes(6).toString('hex');
    const dir = jobDir(id);
    const videoPath = path.join(dir, 'video.mp4');
    const voiceId = (req.body && req.body.voiceId) || (req.query && req.query.voiceId) || process.env.TOPMEDIA_VOICE;

    // run analyzer (Gemini + TopMediaAI stitched mp3)
    const result = await runPythonAnalyze({ videoPath, outDir: dir, voiceId });
    // result: { timeline, lines, script, duration_sec, tts_path }

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
