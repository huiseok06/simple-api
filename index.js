// simple-api/index.js
// 기본 API: /upload, /analyze, /voices, /tts/batch, /result
// Node 18+ 가정 (글로벌 fetch 사용). 필요 시 node-fetch 설치 가능.
// Render 등 일시 디스크 환경 고려 → /tmp 사용

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// ====== 환경설정 ======
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// TopMediai API 키 (필수)
const TOPMEDIAI_API_KEY = process.env.TOPMEDIAI_API_KEY || '';
if (!TOPMEDIAI_API_KEY) {
  console.warn('[WARN] TOPMEDIAI_API_KEY가 설정되지 않았습니다. /voices, /tts/batch 호출 시 실패합니다.');
}

// 업로드/캐시 디렉토리 (Render 등에서는 /tmp 사용 권장)
const BASE_DIR = process.env.DATA_DIR || '/tmp/ai-sports';
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');
const TTS_DIR = path.join(BASE_DIR, 'tts');

for (const d of [BASE_DIR, UPLOAD_DIR, TTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ====== 인메모리 상태 ======
// 실제 운영에서는 DB/Redis 권장. 데모/개발용으로 메모리에 보관.
const store = {
  // uploadId: { filePath, createdAt, segments: [], tts: [], meta: {} }
  items: new Map(),
};

// ====== 유틸 ======
function newId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function ok(res, data) {
  res.json(data);
}

function fail(res, code = 400, message = 'Bad Request') {
  res.status(code).json({ error: message });
}

// 파일 확장자 추정
function guessExt(mimetype = 'application/octet-stream', fallback = 'mp4') {
  const map = { 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a' };
  return map[mimetype] || fallback;
}

// ====== 서버 준비 ======
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 정적 제공: 업로드/tts 파일 접근 (테스트 편의)
// 프로덕션에선 사설 경로나 CDN 사용 고려
app.use('/static/uploads', express.static(UPLOAD_DIR));
app.use('/static/tts', express.static(TTS_DIR));

// ====== 업로드 설정 (multer) ======
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname) || '.' + guessExt(file.mimetype);
      cb(null, `${Date.now()}_${newId('vid_')}${ext}`);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB (Render free는 더 작게 권장)
  },
});

// ====== 헬스체크 ======
app.get('/health', (_, res) => ok(res, { ok: true }));

// ====== 1) 파일 업로드 ======
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return fail(res, 400, 'file 필드가 필요합니다 (multipart/form-data)');
    const uploadId = newId('upl_');
    const item = {
      filePath: req.file.path,
      createdAt: Date.now(),
      segments: [],
      tts: [],
      meta: {},
    };
    store.items.set(uploadId, item);
    ok(res, { uploadId });
  } catch (e) {
    console.error('[upload] error', e);
    fail(res, 500, 'Upload failed');
  }
});

// ====== 2) 분석(세그먼트 생성) ======
app.post('/analyze', async (req, res) => {
  try {
    const { uploadId, sport = 'track', fastMode = true, level = 'beginner' } = req.body || {};
    if (!uploadId) return fail(res, 400, 'uploadId가 필요합니다');

    const item = store.items.get(uploadId);
    if (!item || !fs.existsSync(item.filePath)) return fail(res, 404, '업로드를 찾을 수 없습니다');

    // TODO: 실제 분석 파이프라인 연결
    // - 프레임 샘플링/장면 전환/이벤트 검출
    // - (필요 시) ASR 후 요약/표준화
    // - segment [{id, startMs, endMs, text, levelTag, eventTag?}]
    // 아래는 더미 세그먼트 (데모용)
    const dummy = [
      { id: newId('seg_'), startMs: 0, endMs: 2500, text: '선수들이 스타팅 블록에 섭니다.', levelTag: level, eventTag: 'ready' },
      { id: newId('seg_'), startMs: 2500, endMs: 6000, text: '출발! 반응 속도가 좋습니다.', levelTag: level, eventTag: 'start' },
      { id: newId('seg_'), startMs: 6000, endMs: 12000, text: '2번 레인이 선두로 치고 나갑니다.', levelTag: level, eventTag: 'lead' },
      { id: newId('seg_'), startMs: 12000, endMs: 17000, text: '결승선 통과! 접전 끝에 우승입니다.', levelTag: level, eventTag: 'finish' },
    ];

    item.segments = dummy;
    item.meta = { sport, fastMode, level };
    ok(res, { segments: dummy });
  } catch (e) {
    console.error('[analyze] error', e);
    fail(res, 500, 'Analyze failed');
  }
});

// ====== 3) TopMediai: 보이스 카탈로그 프록시 ======
app.get('/voices', async (_, res) => {
  try {
    if (!TOPMEDIAI_API_KEY) return fail(res, 500, 'TOPMEDIAI_API_KEY 미설정');

    // TODO: 실제 TopMediai API 엔드포인트/파라미터로 교체
    // 예시 (가상):
    // const r = await fetch('https://api.topmediai.com/v1/voices', {
    //   headers: { Authorization: `Bearer ${TOPMEDIAI_API_KEY}` }
    // });
    // const data = await r.json();

    // 데모 더미 응답:
    const data = {
      voices: [
        { id: 'tm_kor_f1', name: 'Korean Female 1', lang: 'ko-KR', gender: 'female', styleTags: ['friendly'] },
        { id: 'tm_kor_m1', name: 'Korean Male 1', lang: 'ko-KR', gender: 'male', styleTags: ['news'] },
      ],
    };

    ok(res, data);
  } catch (e) {
    console.error('[voices] error', e);
    fail(res, 500, 'Voices failed');
  }
});

// ====== 4) TopMediai: 배치 TTS 프록시 ======
app.post('/tts/batch', async (req, res) => {
  try {
    const { uploadId, voiceId, segments = [], speed, pitch, volume } = req.body || {};
    if (!uploadId) return fail(res, 400, 'uploadId가 필요합니다');
    if (!voiceId) return fail(res, 400, 'voiceId가 필요합니다');
    if (!Array.isArray(segments) || segments.length === 0) return fail(res, 400, 'segments가 비었습니다');

    const item = store.items.get(uploadId);
    if (!item) return fail(res, 404, '업로드 세션 없음');

    // TODO: 실제 TopMediai 호출 (배치/병렬 처리 + 재시도 + 타임아웃)
    // 요청당 캐시 키 생성(동일 텍스트/보이스 재사용)
    const cacheKey = crypto.createHash('md5')
      .update(JSON.stringify({ voiceId, speed, pitch, volume, segments: segments.map(s => s.text) }))
      .digest('hex');

    // 데모: 각 세그먼트를 더미 오디오 파일로 치환 (실전에서는 API에서 받은 오디오를 파일로 저장)
    const tts = segments.map((s, idx) => {
      const name = `${Date.now()}_${uploadId}_${idx}.mp3`; // 실제 포맷에 맞춰 확장자 조정
      const outPath = path.join(TTS_DIR, name);
      // 더미 바이트(실제로는 API 응답 오디오를 write)
      fs.writeFileSync(outPath, Buffer.from('ID3'), { flag: 'w' });
      return {
        id: s.id,
        audioUrl: `/static/tts/${name}`,
        durationMs: Math.max(1000, s.endMs - s.startMs), // 대충 길이 추정 (실제는 응답에서 사용)
      };
    });

    item.tts = tts;
    ok(res, { tts, cacheKey });
  } catch (e) {
    console.error('[tts/batch] error', e);
    fail(res, 500, 'TTS failed');
  }
});

// ====== 5) 결과 조회 ======
app.get('/result', (req, res) => {
  try {
    const uploadId = String(req.query.uploadId || '');
    if (!uploadId) return fail(res, 400, 'uploadId가 필요합니다');

    const item = store.items.get(uploadId);
    if (!item) return fail(res, 404, '세션을 찾을 수 없습니다');

    ok(res, {
      segments: item.segments || [],
      tts: item.tts || [],
      meta: item.meta || {},
    });
  } catch (e) {
    console.error('[result] error', e);
    fail(res, 500, 'Result failed');
  }
});

// ====== 오류 핸들러(최종) ======
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  fail(res, 500, 'Internal Server Error');
});

// ====== 서버 시작 ======
app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
  console.log(`UPLOAD_DIR: ${UPLOAD_DIR}`);
  console.log(`TTS_DIR: ${TTS_DIR}`);
});
