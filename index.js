// index.js — Azure TTS 오류(500) 방지용 안전 SSML + 폴백 버전
import ytdl from 'ytdl-core';
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;

// 정적 파일 서빙
app.use('/files', express.static(DATA_DIR));

// 헬스체크
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// 유틸
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ensureDir = async (p) => fs.ensureDir(p);
const escapeXml = (t = '') => String(t)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

// 🔧 숫자 → SSML 안전 문자열로 변환
function toPitchSt(p) {
  const n = Number(p) || 0;             // 0이면 +0st
  return (n >= 0 ? `+${n}` : `${n}`) + 'st';
}
function toRatePct(r) {
  const n = Number(r);
  if (Number.isFinite(n)) {
    // 100은 기준점 → +0%, 110 → +10%, 90 → -10%
    const rel = Math.round(n - 100);
    const sign = rel >= 0 ? `+${rel}` : `${rel}`;
    return `${sign}%`;
  }
  return '+0%';
}

// Azure 보이스 목록
async function azureVoices() {
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY } });
  if (!r.ok) throw new Error(`voices list http ${r.status}`);
  return r.json();
}

// 카탈로그(ko-KR 기본 남/여 + 샘플 프리셋)
function buildCatalog(list) {
  const ko = list.filter(v => v.Locale === 'ko-KR');
  const pickMale = ko.find(v => /InJoon|Hyunsu|Joon|Sang/i.test(v.ShortName))?.ShortName || 'ko-KR-InJoonNeural';
  const pickFemale = ko.find(v => /SunHi|EunBi|JiMin|Ara/i.test(v.ShortName))?.ShortName || 'ko-KR-SunHiNeural';
  return [
    { id: 'ko/male_basic', label: '남성(기본)', tier: 'free', vendor: 'azure', shortName: pickMale, preset: { style: 'general', pitch: -1, rate: 97 } },
    { id: 'ko/female_basic', label: '여성(기본)', tier: 'free', vendor: 'azure', shortName: pickFemale, preset: { style: 'general', pitch: 1, rate: 100 } },
    { id: 'idol/style_a', label: '아이돌 스타일 A', tier: 'pro', vendor: 'azure', shortName: pickFemale, preset: { style: 'cheerful', pitch: 1, rate: 103 } },
    { id: 'brand/karina', label: '브랜드 보이스(계약)', tier: 'pro', vendor: 'azure-custom', shortName: 'ko-KR-BrandKarinaNeural', preset: { style: 'general', pitch: 0, rate: 100 } },
  ];
}

// GET /voices — 보이스 카탈로그 반환
app.get('/voices', async (req, res) => {
  try {
    if (!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)) return res.status(500).json({ error: 'missing azure env' });
    const list = await azureVoices();
    const catalog = buildCatalog(list);
    res.json(catalog);
  } catch (e) {
    console.error('voices failed', e);
    res.status(500).json({ error: 'voices failed' });
  }
});

// 내부 합성 함수
async function synthesize(ssml) {
  const synthUrl = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  return fetch(synthUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'ai-sports-tts'
    },
    body: ssml
  });
}

// POST /tts — { text, voiceId, style, pitch, rate } → { url }
app.post('/tts', async (req, res) => {
  try {
    if (!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)) return res.status(500).json({ error: 'missing azure env' });
    const { text, voiceId, style = 'general', pitch = 0, rate = 100 } = req.body || {};
    if (!text || !voiceId) return res.status(400).json({ error: 'text/voiceId required' });

    // voiceId 매핑
    const list = await azureVoices();
    const catalog = buildCatalog(list);
    const byId = Object.fromEntries(catalog.map(c => [c.id, c]));
    const v = byId[voiceId] || catalog[0];
    const shortName = v.shortName || 'ko-KR-SunHiNeural';

    const pitchStr = toPitchSt(pitch);
    const rateStr  = toRatePct(rate);
    const textEsc  = escapeXml(text);

    const ssmlWithStyle =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<speak version="1.0" xml:lang="ko-KR" xmlns:mstts="https://www.w3.org/2001/mstts">` +
      `<voice name="${shortName}">` +
      `<mstts:express-as style="${style}" styledegree="1">` +
      `<prosody pitch="${pitchStr}" rate="${rateStr}">${textEsc}</prosody>` +
      `</mstts:express-as>` +
      `</voice>` +
      `</speak>`;

    const ssmlPlain =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<speak version="1.0" xml:lang="ko-KR">` +
      `<voice name="${shortName}">` +
      `<prosody pitch="${pitchStr}" rate="${rateStr}">${textEsc}</prosody>` +
      `</voice>` +
      `</speak>`;

    // 1차: 스타일 포함 → 실패 시 2차: 스타일 제거 폴백
    let r = await synthesize(ssmlWithStyle);
    if (!r.ok) {
      const firstDetail = await r.text().catch(() => '');
      console.warn('[azure tts] style synth failed:', firstDetail?.slice(0, 300));
      r = await synthesize(ssmlPlain);
      if (!r.ok) {
        const secondDetail = await r.text().catch(() => '');
        return res.status(500).json({ error: 'azure tts failed', detail: firstDetail || secondDetail });
      }
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const outDir = path.join(DATA_DIR, 'tts');
    await ensureDir(outDir);
    const key = sha256(text + shortName + style + String(pitch) + String(rate));
    const out = path.join(outDir, `${key}.mp3`);
    await fs.writeFile(out, buf);
    const url = `${PUBLIC_BASE_URL}/files/tts/${key}.mp3`;
    res.json({ url });
  } catch (e) {
    console.error('tts failed', e);
    res.status(500).json({ error: 'tts failed' });
  }
});

// POST /title  { youtubeUrl } -> { title }
// 우선순위: ytdl-core → oEmbed → noembed (폴백)
app.post('/title', async (req, res) => {
  const { youtubeUrl } = req.body || {};
  try {
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      return res.status(400).json({ error: 'invalid youtubeUrl' });
    }

    let title = '';
    let firstErr;

    // 1) 기본: ytdl-core
    try {
      const info = await ytdl.getInfo(youtubeUrl);
      title = info?.videoDetails?.title || '';
    } catch (e) {
      firstErr = e;
      console.error('[ytdl-core] failed:', e?.message || e);
    }

    // 2) 폴백: YouTube oEmbed
    if (!title) {
      const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(youtubeUrl);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) {
        const j = await r.json();
        title = j?.title || '';
      } else {
        console.error('[oEmbed] HTTP', r.status);
      }
    }

    // 3) 폴백2: noembed
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
      return res.status(500).json({ error: 'failed to fetch title', reason: firstErr?.message || 'unknown' });
    }
    return res.json({ title });
  } catch (e) {
    console.error('title route fatal:', e);
    return res.status(500).json({ error: 'failed to fetch title' });
  }
});

app.listen(PORT, async () => {
  await ensureDir(DATA_DIR);
  console.log(`Simple API ready on :${PORT}`);
});
