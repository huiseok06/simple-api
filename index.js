// index.js — /health, /title, /jobs(다운로드) + ytdl 헤더 + yt-dlp 폴백
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ytdl from 'ytdl-core';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const YTDL_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
};

// (옵션) Render 환경변수에 YTDLP_PATH=/opt/render/project/src/bin/yt-dlp 가 있다면 자동 사용
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

// 정적 파일 공개: http(s)://.../files/...
app.use('/files', express.static(DATA_DIR));

// ---------- 유틸 ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const toUrl = (abs) =>
  `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g, '/')}`;

async function writeJob(id, patch) {
  const dir = jobDir(id);
  await ensureDir(dir);
  const p = path.join(dir, 'job.json');
  let cur = { id, status: 'queued', progress: 0, createdAt: Date.now(), files: {} };
  if (await fs.pathExists(p)) cur = JSON.parse(await fs.readFile(p, 'utf8'));
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await fs.writeFile(p, JSON.stringify(next, null, 2));
  return next;
}
async function readJob(id) {
  const p = path.join(jobDir(id), 'job.json');
  if (!(await fs.pathExists(p))) return null;
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/render/project/src/bin` };
    const p = spawn(cmd, args, { ...opts, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd}(${c}):\n${out}`))));
  });
}

async function downloadWithYtdlp(url, outPath) {
  // itag 18(360p, 오디오 포함) 우선 → ffmpeg 병합 없이 되는 경우가 많음
  const args = ['-f', '18/mp4', '-o', outPath, url];
  await run(YTDLP, args);
}

// ---------- 라우트 ----------
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// (선택) ffmpeg/yt-dlp 버전 확인
app.get('/ffmpeg', async (req, res) => {
  try {
    const out = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
    res.json({ ok: true, version: out.split('\n')[0] });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});
app.get('/ytdlp', async (req, res) => {
  try {
    const out = await run(YTDLP, ['--version']);
    res.json({ ok: true, version: out.trim() });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// /title — ytdl → oEmbed → noembed 폴백
app.post('/title', async (req, res) => {
  const { youtubeUrl } = req.body || {};
  try {
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }
    let title = '';
    let firstErr;
    try {
      const info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
      title = info?.videoDetails?.title || '';
    } catch (e) {
      firstErr = e;
      console.error('[ytdl-core/title] failed:', e?.statusCode || e?.message || e);
    }
    if (!title) {
      const u = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) title = (await r.json())?.title || '';
    }
    if (!title) {
      const u = 'https://noembed.com/embed?url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(u);
      if (r.ok) title = (await r.json())?.title || '';
    }
    if (!title) return res.status(500).json({ error: 'failed to fetch title', reason: firstErr?.message || 'unknown' });
    res.json({ title });
  } catch (e) {
    console.error('title fatal:', e);
    res.status(500).json({ error: 'failed to fetch title' });
  }
});

// /jobs — 영상 다운로드 잡 생성(즉시 jobId 반환), 백그라운드에서 다운로드
app.post('/jobs', async (req, res) => {
  const { youtubeUrl } = req.body || {};
  try {
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }
    const id = sha256(youtubeUrl).slice(0, 12) + '-' + Date.now().toString(36);
    await writeJob(id, { status: 'downloading', progress: 5, src: youtubeUrl });
    res.json({ jobId: id, status: 'downloading' }); // <- 여기까지 오면 500 안 남

    // 비동기 다운로드
    (async () => {
      const dir = jobDir(id);
      const out = path.join(dir, 'video.mp4');
      try {
        // 1) ytdl-core (헤더 포함)
        const info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
        const f18 = ytdl.chooseFormat(info.formats, { quality: '18' }); // progressive mp4
        const format =
          f18 && f18.hasAudio && f18.hasVideo
            ? f18
            : ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
        await new Promise((resolve, reject) => {
          ytdl
            .downloadFromInfo(info, { format, requestOptions: { headers: YTDL_HEADERS } })
            .pipe(fs.createWriteStream(out))
            .on('finish', resolve)
            .on('error', reject);
        });
        await writeJob(id, { status: 'done', progress: 100, files: { videoPath: out } });
      } catch (e) {
        console.error('[ytdl-core/jobs] failed:', e?.statusCode || e?.message || e);
        // 2) yt-dlp 폴백(있을 때만)
        try {
          await downloadWithYtdlp(youtubeUrl, out);
          await writeJob(id, { status: 'done', progress: 100, files: { videoPath: out } });
        } catch (e2) {
          console.error('[yt-dlp fallback] failed:', e2?.message || e2);
          await writeJob(id, { status: 'failed', progress: 100, error: String(e2?.message || e2) });
        }
      }
    })();
  } catch (e) {
    console.error('jobs fatal:', e);
    res.status(500).json({ error: 'jobs failed' });
  }
});

// /jobs/:id — 상태/URL 조회
app.get('/jobs/:id', async (req, res) => {
  const j = await readJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  const files = j.files || {};
  const out = { ...j, files: { ...files } };
  if (files.videoPath) out.files.videoUrl = toUrl(files.videoPath);
  if (files.outputPath) out.files.downloadUrl = toUrl(files.outputPath);
  res.json(out);
});

app.listen(PORT, async () => {
  await ensureDir(DATA_DIR);
  console.log(`API ready on :${PORT}`);
});
