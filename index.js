// index.js — Title API + YouTube Download Jobs (ytdl-core → yt-dlp 폴백)
// Node 18+ (전역 fetch 사용). ESM 모듈.

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

// ----- 환경값 -----
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
// Render 빌드 커맨드로 내려받은 바이너리 경로(없으면 시스템 PATH)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP  = process.env.YTDLP_PATH  || 'yt-dlp';

// YouTube 요청 헤더(410/403 회피에 도움)
const YTDL_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
};

// 정적 파일: /files/... 로 공개
app.use('/files', express.static(DATA_DIR));

// ----- 유틸 -----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const toUrl = (abs) =>
  `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g, '/')}`;

// 파일 기반 간단 Job 저장
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

// 공용 프로세스 실행
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/render/project/src/bin` };
    const p = spawn(cmd, args, { ...opts, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd} failed(${c}):\n${out}`))));
  });
}

// yt-dlp 폴백 다운로드
async function downloadWithYtdlp(url, outPath) {
  // 합쳐진 mp4 우선, 필요시 ffmpeg로 머지
  const args = [
    '-f',
    "bv*[ext=mp4]+ba[ext=m4a]/mp4",
    '--merge-output-format',
    'mp4',
    '-o',
    outPath,
    url,
  ];
  await run(YTDLP, args);
}

// ytdl-core(진행형 mp4) 다운로드
async function downloadWithYtdl(url, outPath) {
  const info = await ytdl.getInfo(url, { requestOptions: { headers: YTDL_HEADERS } });
  // itag 18(360p, 오디오+비디오) 우선
  const f18 = ytdl.chooseFormat(info.formats, { quality: '18' });
  const format =
    f18 && f18.hasAudio && f18.hasVideo
      ? f18
      : ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
  await new Promise((resolve, reject) => {
    ytdl
      .downloadFromInfo(info, { format, requestOptions: { headers: YTDL_HEADERS } })
      .pipe(fs.createWriteStream(outPath))
      .on('finish', resolve)
      .on('error', reject);
  });
}

// ----- 헬스/체크 -----
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.get('/ffmpeg', async (req, res) => {
  try {
    const out = await run(FFMPEG, ['-version']);
    res.json({ ok: true, version: out.split('\n')[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ----- /title: 유튜브 제목 가져오기 (ytdl → oEmbed → noembed 폴백) -----
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
      console.error('[ytdl-core] failed:', e?.message || e);
    }
    if (!title) {
      const url =
        'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) {
        const j = await r.json();
        title = j?.title || '';
      } else {
        console.error('[oEmbed] HTTP', r.status);
      }
    }
    if (!title) {
      const url = 'https://noembed.com/embed?url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        title = j?.title || '';
      } else {
        console.error('[noembed] HTTP', r.status);
      }
    }
    if (!title) {
      return res
        .status(500)
        .json({ error: 'failed to fetch title', reason: firstErr?.message || 'unknown' });
    }
    return res.json({ title });
  } catch (e) {
    console.error('title route fatal:', e);
    return res.status(500).json({ error: 'failed to fetch title' });
  }
});

// ----- /jobs: 영상 다운로드 잡 생성(ytdl → yt-dlp 폴백) -----
app.post('/jobs', async (req, res) => {
  const { youtubeUrl } = req.body || {};
  try {
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }
    const id = sha256(youtubeUrl).slice(0, 12) + '-' + Date.now().toString(36);
    await writeJob(id, { status: 'downloading', progress: 10, src: youtubeUrl });
    res.json({ jobId: id, status: 'downloading' });

    // 비동기 다운로드
    (async () => {
      try {
        const dir = jobDir(id);
        await ensureDir(dir);
        const out = path.join(dir, 'video.mp4');

        // 1) ytdl-core 시도
        try {
          await downloadWithYtdl(youtubeUrl, out);
        } catch (e) {
          console.error('ytdl-core failed, try yt-dlp...', e?.message || e);
          // 2) yt-dlp 폴백
          await downloadWithYtdlp(youtubeUrl, out);
        }

        await writeJob(id, { status: 'done', progress: 100, files: { videoPath: out } });
      } catch (e) {
        console.error('download failed', e);
        await writeJob(id, {
          status: 'failed',
          progress: 100,
          error: String(e?.message || e),
        });
      }
    })();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'jobs failed' });
  }
});

// ----- /jobs/:id: 상태 조회 -----
app.get('/jobs/:id', async (req, res) => {
  const j = await readJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  const files = j.files || {};
  const out = { ...j };
  out.files = { ...files };
  if (files.videoPath) out.files.videoUrl = toUrl(files.videoPath);
  res.json(out);
});

app.listen(PORT, async () => {
  await ensureDir(DATA_DIR);
  console.log(`Simple API ready on http://localhost:${PORT}`);
});
