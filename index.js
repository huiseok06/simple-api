// C:\simple-api\index.js
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import ytdl from 'ytdl-core';
import { YoutubeTranscript } from 'youtube-transcript';
import { spawn } from 'node:child_process';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;

// 정적 파일: /files/... 로 접근
app.use('/files', express.static(DATA_DIR));

app.get('/health', (req,res)=> res.json({ ok:true, time:Date.now() }));

// ---------- 유틸 ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const toUrl = (abs) => `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g,'/')}`;

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const escapeXml = (t='') => String(t)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

// ---------- Azure TTS ----------
async function azureVoices(){
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY } });
  if(!r.ok) throw new Error(`voices http ${r.status}`);
  return r.json();
}
function pickVoiceShortName(list, voiceId='ko/female_basic'){
  const ko = list.filter(v=> v.Locale==='ko-KR');
  const fallback = ko.find(v=>/SunHi|EunBi|JiMin|Ara/i.test(v.ShortName))?.ShortName || 'ko-KR-SunHiNeural';
  const map = {
    'ko/male_basic': ko.find(v=>/InJoon|Hyunsu|Joon|Sang/i.test(v.ShortName))?.ShortName || 'ko-KR-InJoonNeural',
    'ko/female_basic': fallback,
  };
  return map[voiceId] || fallback;
}
async function azureSynthesizeSSML(ssml){
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
function buildStitchedSSML(lines, shortName, {style='general', pitch=0, rate=100}={}){
  // 라인 사이 간격(다음 시작 - 현재 끝)만큼 break 삽입 → 자연스러운 이어붙임
  let parts = [];
  for(let i=0;i<lines.length;i++){
    const L = lines[i];
    parts.push(`<s>${escapeXml(L.text)}</s>`);
    const next = lines[i+1];
    if(next){
      const gapMs = Math.max(0, Math.round((next.start - L.end)*1000));
      if(gapMs>80) parts.push(`<break time="${gapMs}ms"/>`);
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n`+
    `<speak version="1.0" xml:lang="ko-KR" xmlns:mstts="https://www.w3.org/2001/mstts">`+
    `<voice name="${shortName}">`+
    `<mstts:express-as style="${style}" styledegree="1">`+
    `<prosody pitch="${pitch}st" rate="${rate}%">${parts.join(' ')}</prosody>`+
    `</mstts:express-as>`+
    `</voice>`+
    `</speak>`;
}

// ---------- 다운로드 & 자막 ----------
function getYouTubeId(u){
  try{
    const m1 = u.match(/[?&]v=([^&]+)/); if(m1) return m1[1];
    const m2 = u.match(/youtu\.be\/([^?]+)/); if(m2) return m2[1];
    const m3 = u.match(/youtube\.com\/shorts\/([^?]+)/); if(m3) return m3[1];
    const m4 = u.match(/embed\/([^?]+)/); if(m4) return m4[1];
  }catch{}
  return '';
}
async function downloadProgressiveMp4(youtubeUrl, outPath){
  // itag=18 (360p, mp4, progressive: audio 포함). 고화질은 FFmpeg 병합 필요 → v1은 18 우선.
  const info = await ytdl.getInfo(youtubeUrl);
  const f18 = ytdl.chooseFormat(info.formats, { quality: '18' });
  const format = (f18 && f18.hasAudio && f18.hasVideo) ? f18 : ytdl.chooseFormat(info.formats, { quality: 'lowest' });
  await new Promise((resolve, reject)=>{
    ytdl.downloadFromInfo(info, { format })
      .pipe(fs.createWriteStream(outPath))
      .on('finish', resolve)
      .on('error', reject);
  });
}
async function fetchAutoTranscript(videoId){
  // ko 우선 → en 폴백 → 아무거나 첫 번째
  let items = [];
  try{ items = await YoutubeTranscript.fetchTranscript(videoId, {lang:'ko'}); }catch{}
  if(!items?.length){ try{ items = await YoutubeTranscript.fetchTranscript(videoId, {lang:'en'}); }catch{} }
  if(!items?.length){ items = await YoutubeTranscript.fetchTranscript(videoId).catch(()=>[]); }
  // items: {text, duration, offset(ms)}
  let t=0; const lines=[];
  for(const it of items){
    const start = (it.offset || t)/1000;
    const end = start + (it.duration||0)/1000;
    lines.push({ id: sha256(start+it.text).slice(0,8), start, end, text: it.text });
    t = (it.offset||t) + (it.duration||0);
  }
  return lines;
}

// ---------- 간단 Job 저장소 (파일 기반) ----------
async function writeJob(id, patch){
  const dir = jobDir(id); await ensureDir(dir);
  const p = path.join(dir, 'job.json');
  let cur={ id, status:'queued', progress:0, createdAt:Date.now(), files:{} };
  if(await fs.pathExists(p)) cur = JSON.parse(await fs.readFile(p,'utf8'));
  const next = { ...cur, ...patch, updatedAt:Date.now() };
  await fs.writeFile(p, JSON.stringify(next,null,2));
  return next;
}
async function readJob(id){
  const p = path.join(jobDir(id), 'job.json');
  if(!(await fs.pathExists(p))) return null;
  return JSON.parse(await fs.readFile(p,'utf8'));
}

// ---------- 라우트 ----------
app.get('/voices', async (req,res)=>{
  try{ const list = await azureVoices();
    const ko = list.filter(v=>v.Locale==='ko-KR');
    const male = ko.find(v=>/InJoon|Hyunsu|Joon|Sang/i.test(v.ShortName))?.ShortName || 'ko-KR-InJoonNeural';
    const female = ko.find(v=>/SunHi|EunBi|JiMin|Ara/i.test(v.ShortName))?.ShortName || 'ko-KR-SunHiNeural';
    res.json([
      { id:'ko/male_basic', label:'남성(기본)', tier:'free', vendor:'azure', shortName: male },
      { id:'ko/female_basic', label:'여성(기본)', tier:'free', vendor:'azure', shortName: female },
    ]);
  }catch(e){ console.error(e); res.status(500).json({error:'voices failed'}); }
});

// 1) 잡 생성: 영상 다운로드 + 자동자막 + 스티치 TTS (백그라운드 수행 → 폴링)
app.post('/jobs', async (req,res)=>{
  const { youtubeUrl, voiceId='ko/female_basic' } = req.body || {};
  if(!youtubeUrl || !ytdl.validateURL(youtubeUrl)) return res.status(400).json({error:'invalid youtubeUrl'});
  const id = sha256(youtubeUrl).slice(0,12)+'-'+Date.now().toString(36);
  await writeJob(id, { status:'downloading', progress:5, voiceId });
  res.json({ jobId:id, status:'downloading' });

  // 비동기 처리
  (async()=>{
    try{
      const dir = jobDir(id); await ensureDir(dir);
      const mp4 = path.join(dir,'video.mp4');
      const linesJson = path.join(dir,'lines.json');
      const ttsMp3 = path.join(dir,'tts.mp3');

      // 1) 영상 다운로드(진행형 MP4)
      await downloadProgressiveMp4(youtubeUrl, mp4);
      await writeJob(id, { status:'analyzing', progress:40, files:{ videoPath: mp4 } });

      // 2) 자동자막 → 라인 생성
      const vid = getYouTubeId(youtubeUrl);
      const lines = await fetchAutoTranscript(vid);
      await fs.writeFile(linesJson, JSON.stringify(lines,null,2));
      await writeJob(id, { status:'tts', progress:60, files:{ videoPath: mp4, linesPath: linesJson, editableLinesPath: linesJson } });

      // 3) Azure 스티치 합성(보이스 적용)
      const voices = await azureVoices();
      const shortName = pickVoiceShortName(voices, voiceId);
      const ssml = buildStitchedSSML(lines, shortName, {style:'general', pitch:0, rate:100});
      const buf = await azureSynthesizeSSML(ssml);
      await fs.writeFile(ttsMp3, buf);

      await writeJob(id, { status:'done', progress:100, files:{ videoPath: mp4, editableLinesPath: linesJson, ttsPath: ttsMp3 } });
    }catch(e){ console.error('job failed', e); await writeJob(id, { status:'failed', progress:100, error: String(e?.message||e) }); }
  })();
});

// 2) 잡 조회
app.get('/jobs/:id', async (req,res)=>{
  const j = await readJob(req.params.id);
  if(!j) return res.status(404).json({error:'not found'});
  const files = j.files||{}; const out = { ...j };
  out.files = { ...files };
  if(files.videoPath) out.files.videoUrl = toUrl(files.videoPath);
  if(files.ttsPath) out.files.tts = { stitchedMp3Url: toUrl(files.ttsPath) };
  if(files.editableLinesPath && !files.editableLines){
    out.files.editableLines = JSON.parse(await fs.readFile(files.editableLinesPath,'utf8'));
  }
  if(files.outputPath) out.files.downloadUrl = toUrl(files.outputPath);
  res.json(out);
});

// 3) 라인 수정 → 스티치 TTS 재합성
app.patch('/jobs/:id/captions/:lineId', async (req,res)=>{
  try{
    const { id, lineId } = { id:req.params.id, lineId:req.params.lineId };
    const j = await readJob(id); if(!j) return res.status(404).json({error:'not found'});
    const p = j.files?.editableLinesPath; if(!p) return res.status(400).json({error:'lines missing'});
    const lines = JSON.parse(await fs.readFile(p,'utf8'));
    const idx = lines.findIndex(x=> x.id===lineId);
    if(idx<0) return res.status(404).json({error:'line not found'});
    lines[idx].text = String(req.body?.text || '');
    await fs.writeFile(p, JSON.stringify(lines,null,2));

    const voices = await azureVoices();
    const shortName = pickVoiceShortName(voices, j.voiceId||'ko/female_basic');
    const ssml = buildStitchedSSML(lines, shortName, {style:'general', pitch:0, rate:100});
    const buf = await azureSynthesizeSSML(ssml);
    const ttsMp3 = path.join(jobDir(id),'tts.mp3');
    await fs.writeFile(ttsMp3, buf);
    await writeJob(id, { files:{ ...j.files, editableLinesPath: p, ttsPath: ttsMp3 } });
    return res.json({ ok:true, ttsUrl: toUrl(ttsMp3) });
  }catch(e){ console.error(e); res.status(500).json({error:'patch failed'}); }
});

// 4) 보이스 변경 → 스티치 TTS 재합성
app.put('/jobs/:id/voice', async (req,res)=>{
  try{
    const id = req.params.id; const { voiceId='ko/female_basic' } = req.body||{};
    const j = await readJob(id); if(!j) return res.status(404).json({error:'not found'});
    const p = j.files?.editableLinesPath; if(!p) return res.status(400).json({error:'lines missing'});
    const lines = JSON.parse(await fs.readFile(p,'utf8'));
    const voices = await azureVoices();
    const shortName = pickVoiceShortName(voices, voiceId);
    const ssml = buildStitchedSSML(lines, shortName, {style:'general', pitch:0, rate:100});
    const buf = await azureSynthesizeSSML(ssml);
    const ttsMp3 = path.join(jobDir(id),'tts.mp3');
    await fs.writeFile(ttsMp3, buf);
    const next = await writeJob(id, { voiceId, files:{ ...j.files, editableLinesPath: p, ttsPath: ttsMp3 } });
    return res.json({ ok:true, voiceId: next.voiceId, ttsUrl: toUrl(ttsMp3) });
  }catch(e){ console.error(e); res.status(500).json({error:'voice change failed'}); }
});

// 5) 렌더(원본+TTS 득킹 믹스)
function ffmpeg(args,cwd){ return new Promise((res,rej)=>{ const p=spawn('ffmpeg',args,{cwd}); p.on('close',c=> c===0?res(0):rej(new Error('ffmpeg failed'))); }); }
app.post('/jobs/:id/render', async (req,res)=>{
  try{
    const id=req.params.id; const j=await readJob(id); if(!j) return res.status(404).json({error:'not found'});
    const vid=j.files?.videoPath, tts=j.files?.ttsPath; if(!(vid && tts)) return res.status(400).json({error:'video/tts missing'});
    const out=path.join(jobDir(id),'out.mp4');
    const args=['-y','-i',vid,'-i',tts,'-filter_complex','[0:a]volume=0.35[a0];[a0][1:a]amix=inputs=2:duration=first:dropout_transition=0[m]','-map','0:v','-map','[m]','-c:v','copy','-c:a','aac','-b:a','192k',out];
    await ffmpeg(args);
    await writeJob(id,{ files:{ ...j.files, outputPath: out } });
    res.json({ downloadUrl: toUrl(out) });
  }catch(e){ console.error(e); res.status(500).json({error:'render failed'}); }
});

app.listen(PORT, async ()=>{ await ensureDir(DATA_DIR); console.log(`API ready on :${PORT}`); });