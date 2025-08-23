// index.js — Local MP4 upload + TopMediaAI TTS (ESM)
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 정적 파일
app.use('/files', express.static(DATA_DIR));
app.get('/health', (req,res)=> res.json({ ok:true, time:Date.now() }));

// -------- util --------
const ensureDir = (p)=> fs.ensureDir(p);
const toUrl = (abs)=> `${PUBLIC_BASE_URL}/files/${path.relative(DATA_DIR, abs).replace(/\\/g,'/')}`;
const jobDir = (id)=> path.join(DATA_DIR, 'uploads', id);
const DEFAULT_SCRIPT = process.env.DEFAULT_SCRIPT || '50m 통과, 5레인 근소 우세. 마지막 구간 스퍼트! 결승선 통과!';

// -------- TopMediaAI TTS wrapper (엔드포인트/헤더는 환경변수로 교정) --------
async function synthTopMediaAI(text, { voiceId }={}){
  const API = process.env.TOPMEDIA_API_URL || 'https://api.topmediai.com/v1/tts';
  const KEY = process.env.TOPMEDIA_API_KEY || '';
  const AUTH_STYLE = (process.env.TOPMEDIA_AUTH_STYLE || 'Bearer').toLowerCase();
  const voice = voiceId || process.env.TOPMEDIA_VOICE || 'ko_female_basic';

  if(!KEY) throw new Error('TOPMEDIA_API_KEY missing');

  const payload = { text, voice, format: 'mp3' };

  // 1) Authorization: Bearer <KEY>
  const h1 = { 'Content-Type':'application/json', 'Authorization': `Bearer ${KEY}` };
  // 2) x-api-key: <KEY>
  const h2 = { 'Content-Type':'application/json', 'x-api-key': KEY };

  const tryOnce = async(headers)=>{
    const r = await fetch(API, { method:'POST', headers, body: JSON.stringify(payload) });
    if(r.ok){
      // 일부 API는 JSON {url:...}을, 일부는 바이너리를 바로 돌려줍니다.
      const ct = r.headers.get('content-type') || '';
      if(ct.includes('application/json')){
        const j = await r.json();
        if(j.url){
          const r2 = await fetch(j.url);
          if(!r2.ok) throw new Error(`download failed ${r2.status}`);
          return Buffer.from(await r2.arrayBuffer());
        }
        if(j.audioContent){ // base64 케이스
          return Buffer.from(j.audioContent, 'base64');
        }
        throw new Error('unexpected JSON shape from TTS');
      } else {
        return Buffer.from(await r.arrayBuffer());
      }
    }
    const msg = await r.text().catch(()=>`http ${r.status}`);
    throw new Error(msg || `http ${r.status}`);
  };

  try{
    return await tryOnce(AUTH_STYLE.startsWith('bearer') ? h1 : h2);
  }catch(e1){
    // 다른 헤더 스타일로 재시도
    try{ return await tryOnce(AUTH_STYLE.startsWith('bearer') ? h2 : h1); }
    catch(e2){ throw new Error(`TopMediaAI TTS failed: ${String(e1)} / ${String(e2)}`); }
  }
}

// -------- 업로드(MP4) --------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const id = crypto.randomBytes(6).toString('hex') + '-' + Date.now().toString(36);
    req.uploadId = id;
    const dir = jobDir(id);
    ensureDir(dir).then(()=> cb(null, dir)).catch(err=> cb(err));
  },
  filename: (req, file, cb) => cb(null, 'video.mp4')
});
const upload = multer({ storage });

// POST /upload  (multipart/form-data, field name: video)
app.post('/upload', upload.single('video'), async (req,res)=>{
  try{
    const id = req.uploadId || crypto.randomBytes(6).toString('hex');
    const dir = jobDir(id);
    const videoPath = path.join(dir, 'video.mp4');
    // 고정 대본으로 TTS 합성
    const buf = await synthTopMediaAI(DEFAULT_SCRIPT, { voiceId: process.env.TOPMEDIA_VOICE });
    const ttsPath = path.join(dir, 'tts.mp3');
    await fs.writeFile(ttsPath, buf);

    return res.json({
      jobId: id,
      script: DEFAULT_SCRIPT,
      videoUrl: toUrl(videoPath),
      ttsUrl: toUrl(ttsPath),
      status: 'ready'
    });
  }catch(e){
    console.error('upload failed', e);
    res.status(500).json({ error:'upload/tts failed', detail: String(e?.message||e) });
  }
});

app.listen(PORT, async ()=>{ await ensureDir(DATA_DIR); console.log(`API ready on :${PORT}`); });