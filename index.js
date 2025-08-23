// index.js — Title line + Azure TTS + YouTube download with ytdl-core → yt-dlp fallback (ESM)
// -------------------------------------------------------------------------------------------------
// 필요 패키지: express, cors, fs-extra, ytdl-core
// Render 권장 환경변수:
//   NODE_VERSION=18
//   PUBLIC_BASE_URL=https://<your-onrender-url>
//   DATA_DIR=./data
//   AZURE_SPEECH_KEY=...
//   AZURE_SPEECH_REGION=eastus
//   FFMPEG_PATH=/opt/render/project/src/bin/ffmpeg     (리포 포함 방식이라면)
//   YTDLP_PATH=/opt/render/project/src/bin/yt-dlp      (Build Command가 yt-dlp 받도록 설정했다면)

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
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

// YouTube가 막을 때 대응용 요청 헤더(410/403 완화)
const YTDL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8'
};

// 정적파일: /files/** 로 공개
app.use('/files', express.static(DATA_DIR));

// ── 유틸 ─────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const toUrl = (abs) => `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g,'/')}`;
const escapeXml = (t='') => String(t)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

function run(cmd, args, opts={}){
  return new Promise((resolve, reject)=>{
    const env = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/render/project/src/bin` };
    const p = spawn(cmd, args, { ...opts, env });
    let out='';
    p.stdout.on('data', d=> out+=d.toString());
    p.stderr.on('data', d=> out+=d.toString());
    p.on('close', c=> c===0 ? resolve(out) : reject(new Error(`${cmd} failed(${c}):\n${out}`)));
  });
}

async function downloadWithYtdlp(url, outPath){
  // mp4 우선, 필요 시 ffmpeg로 병합. -o 에 최종 경로 사용
  const args = [
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/mp4',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    url,
  ];
  await run(YTDLP, args);
}

// ── Azure TTS ───────────────────────────────────────────────────
function pickKoShortName(voiceId='ko/female_basic'){
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

// ── 제목 가져오기(폴백 포함) ─────────────────────────────────────
async function fetchTitleFromUrl(youtubeUrl){
  let title=''; let firstErr;
  try{
    const info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
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
  if(!title) throw new Error(firstErr?.message || 'failed to fetch title');
  return title;
}

app.post('/title', async (req,res)=>{
  const { youtubeUrl } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)) return res.status(400).json({ error:'invalid youtubeUrl' });
    const title = await fetchTitleFromUrl(youtubeUrl);
    res.json({ title });
  }catch(e){ res.status(500).json({ error:'failed to fetch title', detail:String(e?.message||e) }); }
});

// ── /jobs: 영상 다운로드 + "제목 1줄" 타임라인 + TTS ───────────
app.post('/jobs', async (req,res)=>{
  const { youtubeUrl, voiceId='ko/female_basic' } = req.body || {};
  try{
    if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)) return res.status(400).json({ error:'invalid youtubeUrl' });

    const id = sha256(youtubeUrl).slice(0,12) + '-' + Date.now().toString(36);
    await writeJob(id, { status:'downloading', progress:10, src: youtubeUrl, voiceId });
    res.json({ jobId: id, status: 'downloading' });

    (async()=>{
      try{
        const dir = jobDir(id); await ensureDir(dir);
        const mp4 = path.join(dir, 'video.mp4');
        const linesJson = path.join(dir,'lines.json');
        const ttsMp3 = path.join(dir,'tts.mp3');

        let info = null;
        let title = '';
        let durationSec = 8;

        // 1) 메타 시도 (제목/길이 확보)
        try{
          info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
          title = info?.videoDetails?.title || '';
          durationSec = Number(info?.videoDetails?.lengthSeconds || durationSec);
        }catch{ /* 무시하고 폴백 */ }

        // 2) 다운로드: ytdl-core → 실패 시 yt-dlp 폴백
        try{
          if(!info) info = await ytdl.getInfo(youtubeUrl, { requestOptions: { headers: YTDL_HEADERS } });
          const f18 = ytdl.chooseFormat(info.formats, { quality: '18' });
          const format = (f18 && f18.hasAudio && f18.hasVideo)
            ? f18
            : ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
          await new Promise((resolve, reject)=>{
            ytdl.downloadFromInfo(info, { format, requestOptions: { headers: YTDL_HEADERS } })
              .pipe(fs.createWriteStream(mp4))
              .on('finish', resolve)
              .on('error', reject);
          });
        } catch (e) {
          console.error('ytdl-core failed, trying yt-dlp...', e?.statusCode || e?.message || e);
          await downloadWithYtdlp(youtubeUrl, mp4);
        }

        await writeJob(id, { status:'analyzing', progress:60, files:{ videoPath: mp4 } });

        // 3) 제목 확보(없다면 폴백 호출)
        if(!title){ try{ title = await fetchTitleFromUrl(youtubeUrl); }catch{ title = '제목'; } }
        if(!durationSec || !isFinite(durationSec)) durationSec = 8;

        // 4) "제목 한 줄" 타임라인 (0초→min(6초, 전체길이))
        const line = { id: sha256(title).slice(0,8), start: 0, end: Math.min(6, durationSec), text: title };
        await fs.writeFile(linesJson, JSON.stringify([line], null, 2));

        // 5) Azure TTS (제목 읽기)
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
