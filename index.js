// index.js — Title line + Azure TTS + minimal YouTube download (ESM)
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ytdl from 'ytdl-core';

const YTDL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8'
};

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 정적파일: /files/** 로 공개
app.use('/files', express.static(DATA_DIR));

// ── 유틸 ─────────────────────────────────────────────────────────
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
const escapeXml = (t='') => String(t)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

// ── Azure TTS ───────────────────────────────────────────────────
function pickKoShortName(voiceId='ko/female_basic'){
  // 간단 매핑(리스트 호출 없이 안전)
  if(voiceId==='ko/male_basic') return 'ko-KR-InJoonNeural';
  return 'ko-KR-SunHiNeural';
}
async function azureSynthesizeSSML(ssml){
  if(!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)) {
    throw new Error('missing AZURE_SPEECH_KEY/AZURE_SPEECH_REGION');
  }
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const r = await fetch(url, {
    method:'POST',
    headers:{
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type':'application/ssml+xml',
      'X-Microsoft-OutputFormat':'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent':'ai-sports-tts'
    },
    body:ssml
  });
  if(!r.ok){ const detail=await r.text(); throw new Error(`azure tts failed: ${detail}`); }
  return Buffer.from(await r.arrayBuffer());
}

// ── 헬스 & ffmpeg 버전 ───────────────────────────────────────────
app.get('/health', (req,res)=> res.json({ ok:true, time:Date.now() }));

app.get('/ffmpeg', (req,res)=>{
  try{
    const p = spawn(FFMPEG, ['-version']);
    let out=''; p.stdout.on('data',d=> out+=d.toString()); p.stderr.on('data',d=> out+=d.toString());
    p.on('close', c=> res.json({ ok: c===0, version: out.split('\n')[0] || out.trim() }));
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// ── /title(그대로 유지) ─────────────────────────────────────────
app.post('/title', async (req,res)=>{
  const { youtubeUrl } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)){
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }
    let title = '';
    let firstErr;
    try{
      const info = await ytdl.getInfo(youtubeUrl);
      title = info?.videoDetails?.title || '';
    }catch(e){ firstErr = e; }
    if(!title){
      const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if(r.ok){ const j = await r.json(); title = j?.title || ''; }
    }
    if(!title){
      const url = 'https://noembed.com/embed?url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url); if(r.ok){ const j = await r.json(); title = j?.title || ''; }
    }
    if(!title){ return res.status(500).json({ error:'failed to fetch title', reason:firstErr?.message||'unknown' }); }
    res.json({ title });
  }catch(e){ res.status(500).json({ error:'failed to fetch title' }); }
});

// ── /jobs: 영상 다운로드 + "제목 1줄" 타임라인 + TTS 합성 ─────────
app.post('/jobs', async (req,res)=>{
  const { youtubeUrl, voiceId='ko/female_basic' } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)){
      return res.status(400).json({ error:'invalid youtubeUrl' });
    }
    const id = sha256(youtubeUrl).slice(0,12) + '-' + Date.now().toString(36);
    await writeJob(id, { status:'downloading', progress:10, src: youtubeUrl, voiceId });
    res.json({ jobId: id, status: 'downloading' });

    // 백그라운드 처리
    (async()=>{
      try{
        const dir = jobDir(id); await ensureDir(dir);
        const mp4 = path.join(dir, 'video.mp4');
        const linesJson = path.join(dir,'lines.json');
        const ttsMp3 = path.join(dir,'tts.mp3');

        // 1) info+다운로드 (itag 18 = mp4(360p)+오디오 포함)
        const info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
        const f18 = ytdl.chooseFormat(info.formats, { quality: '18' });
        const format = (f18 && f18.hasAudio && f18.hasVideo) ? f18 : ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
        await new Promise((resolve, reject)=>{
          ytdl.downloadFromInfo(info, { format, requestOptions: { headers: YTDL_HEADERS } })
            .pipe(fs.createWriteStream(out))
            .on('finish', resolve)
            .on('error', reject);
        });

        // 2) "제목 한 줄" 타임라인 (0초→min(6초, 전체길이))
        const line = { id: sha256(title).slice(0,8), start: 0, end: Math.min(6, durationSec), text: title };
        await fs.writeFile(linesJson, JSON.stringify([line], null, 2));

        // 3) Azure TTS (제목 읽기)
        const shortName = pickKoShortName(voiceId);
        const ssml = `<?xml version="1.0" encoding="utf-8"?>\n`+
          `<speak version="1.0" xml:lang="ko-KR" xmlns:mstts="https://www.w3.org/2001/mstts">`+
          `<voice name="${shortName}"><mstts:express-as style="general"><prosody rate="100%">${escapeXml(title)}</prosody></mstts:express-as></voice>`+
          `</speak>`;
        const buf = await azureSynthesizeSSML(ssml);
        await fs.writeFile(ttsMp3, buf);

        await writeJob(id, { status:'done', progress:100, files:{ videoPath: mp4, editableLinesPath: linesJson, ttsPath: ttsMp3 } });
      }catch(e){
        console.error('job failed', e);
        await writeJob(id, { status:'failed', progress:100, error: String(e?.message||e) });
      }
    })();
  }catch(e){ console.error(e); return res.status(500).json({ error:'jobs failed' }); }
});

// 상태 조회
app.get('/jobs/:id', async (req,res)=>{
  const j = await readJob(req.params.id);
  if(!j) return res.status(404).json({ error:'not found' });
  const files = j.files || {};
  const out = { ...j };
  out.files = { ...files };
  if(files.videoPath) out.files.videoUrl = toUrl(files.videoPath);
  if(files.ttsPath) out.files.tts = { stitchedMp3Url: toUrl(files.ttsPath) };
  if(files.editableLinesPath && !files.editableLines){
    out.files.editableLines = JSON.parse(await fs.readFile(files.editableLinesPath,'utf8'));
  }
  if(files.outputPath) out.files.downloadUrl = toUrl(files.outputPath);
  res.json(out);
});

app.listen(PORT, async ()=>{ await ensureDir(DATA_DIR); console.log(`Simple API ready on http://localhost:${PORT}`); });
