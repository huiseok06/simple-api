// C:\simple-api\index.js
import express from 'express';
import cors from 'cors';
import ytdl from 'ytdl-core';

const app = express();
app.use(cors());
app.use(express.json());

// 헬스체크 (폰/배포 환경에서 네트워크 확인용)
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// POST /title  { youtubeUrl } -> { title }
// ytdl-core가 실패하면 oEmbed / noembed로 폴백
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Simple API ready on http://localhost:${PORT}`);
});