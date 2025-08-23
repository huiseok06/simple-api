// index.js — Title API + Minimal YouTube Download Jobs (ESM)
// ---------------------------------------------------------
// 필요 패키지: express, cors, fs-extra, ytdl-core (package.json에 포함)
// Node 18+ (전역 fetch 사용). Render 환경변수: NODE_VERSION=18 권장.

import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import ytdl from 'ytdl-core';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 정적 파일: /files/... 로 공개
app.use('/files', express.static(DATA_DIR));

// -------- 유틸 --------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const toUrl = (abs) => `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g,'/')}`;

async function writeJob(id, patch){
  const dir = jobDir(id); await ensureDir(dir);
  const p = path.join(dir, 'job.json');
  let cur = { id, status:'queued', progress:0, createdAt:Date.now(), files:{} };
  if(await fs.pathExists(p)) cur = JSON.parse(await fs.readFile(p,'utf8'));
  const next = { ...cur, ...patch, updatedAt:Date.now() };
  await fs.writeFile(p, JSON.stringify(next,null,2));
  return next;
}
async function readJob(id){
  const p = path.join(jobDir(id),'job.json');
  if(!(await fs.pathExists(p))) return null;
  return JSON.parse(await fs.readFile(p,'utf8'));
}

// -------- 헬스 --------
app.get('/health', (req,res)=> res.json({ ok:true, time:Date.now() }));

// -------- /title: 유튜브 제목 가져오기 --------
// 우선 ytdl-core → 실패 시 oEmbed → noembed 폴백
app.post('/title', async (req,res)=>{
  const { youtubeUrl } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)){
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }
    let title = '';
    let firstErr;
    // 1) ytdl-core
    try{
      const info = await ytdl.getInfo(youtubeUrl);
      title = info?.videoDetails?.title || '';
    }catch(e){ firstErr = e; console.error('[ytdl-core] failed:', e?.message || e); }
    // 2) YouTube oEmbed
    if(!title){
      const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if(r.ok){ const j = await r.json(); title = j?.title || ''; }
      else { console.error('[oEmbed] HTTP', r.status); }
    }
    // 3) noembed
    if(!title){
      const url = 'https://noembed.com/embed?url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url);
      if(r.ok){ const j = await r.json(); title = j?.title || ''; }
      else { console.error('[noembed] HTTP', r.status); }
    }
    if(!title){ return res.status(500).json({ error:'failed to fetch title', reason: firstErr?.message || 'unknown' }); }
    return res.json({ title });
  }catch(e){ console.error('title route fatal:', e); return res.status(500).json({ error:'failed to fetch title' }); }
});

// -------- /jobs: 최소한의 다운로드 잡(영상만 다운로드) --------
// 입력: { youtubeUrl } → 응답: { jobId }
// 백그라운드로 itag 18(360p, 오디오 포함) MP4를 저장
app.post('/jobs', async (req,res)=>{
  const { youtubeUrl } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)){
      return res.status(400).json({ error:'invalid youtubeUrl' });
    }
    const id = sha256(youtubeUrl).slice(0,12) + '-' + Date.now().toString(36);
    await writeJob(id, { status:'downloading', progress:10, src: youtubeUrl });
    res.json({ jobId: id, status: 'downloading' });

    // 비동기 다운로드
    (async()=>{
      try{
        const dir = jobDir(id); await ensureDir(dir);
        const out = path.join(dir, 'video.mp4');
        const info = await ytdl.getInfo(youtubeUrl);
        // progressive MP4(오디오 포함) 우선
        const f18 = ytdl.chooseFormat(info.formats, { quality: '18' });
        const format = (f18 && f18.hasAudio && f18.hasVideo) ? f18 : ytdl.chooseFormat(info.formats, { quality: 'lowest' });
        await new Promise((resolve, reject)=>{
          ytdl.downloadFromInfo(info, { format })
            .pipe(fs.createWriteStream(out))
            .on('finish', resolve)
            .on('error', reject);
        });
        await writeJob(id, { status:'done', progress:100, files:{ videoPath: out } });
      }catch(e){ console.error('download failed', e); await writeJob(id, { status:'failed', progress:100, error: String(e?.message||e) }); }
    })();
  }catch(e){ console.error(e); return res.status(500).json({ error:'jobs failed' }); }
});

// 조회: /jobs/:id → { status, files: { videoUrl? } }
app.get('/jobs/:id', async (req,res)=>{
  const j = await readJob(req.params.id);
  if(!j) return res.status(404).json({ error:'not found' });
  const files = j.files || {};
  const out = { ...j };
  out.files = { ...files };
  if(files.videoPath) out.files.videoUrl = toUrl(files.videoPath);
  res.json(out);
});

app.listen(PORT, async ()=>{ await ensureDir(DATA_DIR); console.log(`Simple API ready on http://localhost:${PORT}`); });
