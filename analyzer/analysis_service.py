# analyzer/analysis_service.py
# 런타임 의존성:
#   - apt: ffmpeg, python3, python3-pip
#   - pip: opencv-python-headless pillow numpy pydub requests google-generativeai
# 환경 변수:
#   - GEMINI_API_KEY (필수)
#   - TOPMEDIA_API_KEY (필수)
#   - [옵션] TOPMEDIA_API_URL(기본: https://api.topmediai.com/v1/text2speech)
#   - [옵션] TOPMEDIA_VOICE (기본: ko_female_basic)

import os, sys, json, time, argparse, tempfile, random, base64
from http.client import RemoteDisconnected
from typing import Optional

import cv2
import numpy as np
from PIL import Image  # noqa: F401
import requests
from pydub import AudioSegment
import google.generativeai as genai

# ------------------------ 공통 유틸 ------------------------

def write_json_atomic(path: str, obj: dict):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def _backoff_sleep(i: int, base: float = 1.0, cap: float = 20.0):
    wait = min(cap, base * (2 ** i)) + random.random()
    time.sleep(wait)

def _clean_json_text(text: str) -> str:
    if not text: return text
    return text.strip().replace("```json", "").replace("```", "").strip()

def _is_rate_limit(e: Exception) -> bool:
    s = str(e).lower()
    return any(k in s for k in ["429", "rate limit", "quota", "resource exhausted"])

def _should_retry_exception(e: Exception) -> bool:
    if isinstance(e, (ConnectionError, TimeoutError, RemoteDisconnected, ConnectionResetError)):
        return True
    s = str(e).lower()
    if any(k in s for k in ["connection", "timeout", "protocol", "chunked"]): return True
    if _is_rate_limit(e): return True
    return False

# ------------------------ Gemini 래퍼(강화판) ------------------------

class ResilientGemini:
    def __init__(self, api_key: str, model_name="gemini-1.5-pro-latest",
                 default_timeout=120.0, poll_interval=0.5, max_polls=60):
        self.api_key = api_key
        self.model_name = model_name
        self.default_timeout = float(default_timeout)
        self.poll_interval = float(poll_interval)
        self.max_polls = int(max_polls)
        self._reset_client()

    def _reset_client(self):
        genai.configure(api_key=self.api_key)
        self.model = genai.GenerativeModel(
            model_name=self.model_name,
            generation_config={"response_mime_type": "application/json", "temperature": 0.0}
        )

    def upload_file_retry(self, path: str, mime_type: str = None, retries=6, backoff_base=1.0):
        last_err = None
        for i in range(retries):
            try:
                f = genai.upload_file(path, mime_type=mime_type)
                name = getattr(f, "name", None)
                if not name: return f
                for _ in range(self.max_polls):
                    g = genai.get_file(name)
                    state = getattr(getattr(g, "state", None), "name", None) or getattr(g, "state", None)
                    if str(state).upper() == "ACTIVE": return g
                    time.sleep(self.poll_interval)
                return g
            except Exception as e:
                last_err = e
                if not _should_retry_exception(e): raise
                try: self._reset_client()
                except Exception: pass
                _backoff_sleep(i, base=backoff_base)
        raise RuntimeError(f"upload_file_retry failed: {last_err}")

    def generate_json_retry(self, parts, timeout=None, retries=6, backoff_base=1.0):
        tmo = float(timeout or self.default_timeout)
        last_err = None
        for i in range(retries):
            try:
                resp = self.model.generate_content(parts, request_options={"timeout": tmo})
                text = (getattr(resp, "text", None) or "").strip()
                if not text:
                    try:
                        cands = getattr(resp, "candidates", None) or []
                        if cands and getattr(cands[0], "content", None):
                            pieces = []
                            for p in (cands[0].content.parts or []):
                                t = getattr(p, "text", None)
                                if t: pieces.append(t)
                            text = "".join(pieces).strip()
                    except Exception:
                        pass
                if not text:
                    pf = getattr(resp, "prompt_feedback", None)
                    raise RuntimeError(f"Gemini returned empty response. Check GEMINI_API_KEY / quota / safety. prompt_feedback={pf}")
                cleaned = _clean_json_text(text)
                try:
                    return json.loads(cleaned)
                except Exception as je:
                    preview = cleaned[:400]
                    raise RuntimeError(f"Gemini non-JSON response preview: {preview}") from je
            except Exception as e:
                last_err = e
                if not _should_retry_exception(e): raise
                try: self._reset_client()
                except Exception: pass
                _backoff_sleep(i, base=backoff_base)
        raise RuntimeError(f"generate_json_retry failed: {last_err}")

# ------------------------ 분석 파이프라인 ------------------------

def extract_frames_per_second(video_path: str, fps: int = 1):
    temp_dir = tempfile.mkdtemp(prefix="frames_")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened(): raise RuntimeError("비디오를 열 수 없습니다.")
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    vid_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    duration_sec = (total_frames / max(vid_fps, 1e-6)) if total_frames else 0.0
    step = max(int(vid_fps / max(fps, 1)), 1)
    frames, i, t = [], 0, 0.0
    while True:
        ret = cap.grab()
        if not ret: break
        if i % step == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                h, w = frame.shape[:2]
                small = cv2.resize(frame, (int(w * (480 / h)), 480)) if h > 0 else frame
                path = os.path.join(temp_dir, f"frame_{int(t)}.jpg")
                cv2.imwrite(path, small)
                frames.append({"path": path, "time": int(t)})
        i += 1
        t = i / max(vid_fps, 1e-6)
    cap.release()
    return frames, float(duration_sec)

def get_major_key_events(R: ResilientGemini, frames):
    if not frames: return []
    parts = [
        "당신은 스포츠 영상의 하이라이트만 뽑아내는 스토리 분석가입니다.\n",
        "JSON 배열 하나만 출력:\n",
        '[{"start":초, "event_description":"..."}]\n',
        "--- 프레임 목록 ---\n",
    ]
    for f in frames:
        uf = R.upload_file_retry(f["path"], "image/jpeg")
        parts.append(f"시간: {f['time']}초")
        parts.append(uf)
    js = R.generate_json_retry(parts, timeout=600)
    events, seen = [], set()
    for e in js:
        try:
            st = int(max(0, round(float(e.get("start", 0)))))
            desc = str(e.get("event_description", "")).strip()
        except Exception:
            continue
        if st in seen: continue
        seen.add(st)
        events.append({"start": st, "event_description": desc or "주요 하이라이트"})
    events.sort(key=lambda x: x["start"])
    if not events and frames:
        t0, t1 = frames[0]["time"], frames[-1]["time"]
        mid = int((t0 + t1) // 2)
        events = [{"start": max(0, mid), "event_description": "주요 하이라이트"}]
    return events

def fill_gaps(R: ResilientGemini, timeline, frames, max_gap=10):
    if not timeline: return []
    out, timeline = [], sorted(timeline, key=lambda x: x["start"])
    for i, cur in enumerate(timeline):
        out.append(cur)
        if i == len(timeline) - 1: break
        nxt, gap = timeline[i + 1], int(timeline[i + 1]["start"] - cur["start"])
        if gap > max_gap:
            gap_frames = [f for f in frames if cur["start"] < f["time"] < nxt["start"]]
            if not gap_frames:
                n, step = max(1, gap // 7), gap / (1 + max(1, gap // 7))
                for k in range(max(1, gap // 7)):
                    out.append({"start": int(round(cur["start"] + (k + 1) * step)), "event_description": "중간 하이라이트"})
                continue
            parts = [
                f"{cur['start']}초와 {nxt['start']}초 사이 공백을 메우세요.\n",
                "5~10초 간격의 보조 사건을 JSON 배열로만:\n",
                '[{"start":초,"event_description":"..."}]\n',
                "--- 이 구간 프레임들 ---\n",
            ]
            for f in gap_frames:
                uf = R.upload_file_retry(f["path"], "image/jpeg")
                parts.append(f"시간: {f['time']}초")
                parts.append(uf)
            try:
                js = R.generate_json_retry(parts, timeout=600)
                for e in js:
                    try:
                        st = int(round(float(e.get("start", cur["start"] + 1))))
                        desc = str(e.get("event_description", "")).strip() or "중간 하이라이트"
                    except Exception:
                        continue
                    st = max(cur["start"] + 1, min(nxt["start"] - 1, st))
                    out.append({"start": st, "event_description": desc})
            except Exception:
                n, step = max(1, gap // 7), gap / (1 + max(1, gap // 7))
                for k in range(max(1, gap // 7)):
                    out.append({"start": int(round(cur["start"] + (k + 1) * step)), "event_description": "중간 하이라이트"})
    tmp = {e["start"]: e for e in out}
    return sorted(tmp.values(), key=lambda x: x["start"])

def script_from_timeline(R: ResilientGemini, timeline):
    if not timeline: return []
    lines = []
    for i, cur in enumerate(timeline):
        available = (timeline[i + 1]["start"] - cur["start"]) if i < len(timeline) - 1 else 8
        if available <= 0: continue
        prompt = [
            "아래 사건에 대한 해설 대사를 작성하고, 해당 길이를 주어진 시간 안에 말하기 위한 적정 배속(rate)을 계산하세요.\n",
            'JSON 한 개: {"text":"...", "rate":숫자}\n',
            f"사건: {cur['start']}초 - {cur['event_description']}\n",
            f"시간제한: {float(available):.2f}초\n",
        ]
        try:
            js = R.generate_json_retry(prompt, timeout=180)
            text = str(js.get("text", "")).strip() or cur["event_description"]
            rate = float(js.get("rate", 1.0))
            lines.append({"id": f"e{i}", "start": int(cur["start"]), "text": text, "rate": max(0.5, min(2.0, rate))})
        except Exception:
            lines.append({"id": f"e{i}", "start": int(cur["start"]), "text": cur["event_description"], "rate": 1.0})
    return lines

# ------------------------ TopMediaAI TTS ------------------------

TOPMEDIA_TTS_API = os.environ.get("TOPMEDIA_API_URL", "https://api.topmediai.com/v1/text2speech")
TOPMEDIA_VOICES_API = "https://api.topmediai.com/v1/voices_list"
_SPEAKER_CACHE = None

def _fetch_voices(key: str):
    r = requests.get(TOPMEDIA_VOICES_API, headers={"x-api-key": key}, timeout=60)
    r.raise_for_status()
    if "application/json" in (r.headers.get("content-type") or ""):
        j = r.json()
        return (j.get("Voice") or []) if isinstance(j, dict) else []
    return []

def resolve_speaker_id(desired: Optional[str], key: str) -> str:
    global _SPEAKER_CACHE
    if desired and isinstance(desired, str) and "-" in desired and len(desired) >= 8:
        return desired
    if _SPEAKER_CACHE is None:
        _SPEAKER_CACHE = _fetch_voices(key)
    if desired:
        for v in _SPEAKER_CACHE or []:
            if str(v.get("urlname", "")).lower() == desired.lower() or str(v.get("name", "")).lower() == desired.lower():
                return v.get("speaker") or v.get("modeltoken") or ""
    for v in _SPEAKER_CACHE or []:
        if "korean" in str(v.get("Languagename", "")).lower():
            return v.get("speaker") or v.get("modeltoken") or ""
    if _SPEAKER_CACHE:
        return _SPEAKER_CACHE[0].get("speaker") or _SPEAKER_CACHE[0].get("modeltoken") or ""
    raise RuntimeError("TopMediai voices not available")

def _find_audio_in_json(j: dict) -> Optional[bytes]:
    def _find_url(d: dict) -> Optional[str]:
        for k in ("url", "oss_url", "audio_url", "oss_audio_url", "audioUrl"):
            v = d.get(k)
            if isinstance(v, str) and v.startswith("http"):
                return v
        return None

    if not isinstance(j, dict):
        return None

    u = _find_url(j)
    if u:
        r2 = requests.get(u, timeout=120)
        r2.raise_for_status()
        return r2.content

    for k in ("audio", "audioContent", "audio_base64", "audioBase64"):
        b64 = j.get(k)
        if isinstance(b64, str) and b64:
            return base64.b64decode(b64)

    data = j.get("data")
    if isinstance(data, dict):
        u = _find_url(data)
        if u:
            r2 = requests.get(u, timeout=120)
            r2.raise_for_status()
            return r2.content
        for k in ("audio", "audioContent", "audio_base64", "audioBase64"):
            b64 = data.get(k)
            if isinstance(b64, str) and b64:
                return base64.b64decode(b64)

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            u = _find_url(item)
            if u:
                r2 = requests.get(u, timeout=120)
                r2.raise_for_status()
                return r2.content
            for k in ("audio", "audioContent", "audio_base64", "audioBase64"):
                b64 = item.get(k)
                if isinstance(b64, str) and b64:
                    return base64.b64decode(b64)

    return None

def topmedia_speak(text: str, voice: str) -> bytes:
    key = os.environ.get("TOPMEDIA_API_KEY", "")
    if not key:
        raise RuntimeError("TOPMEDIA_API_KEY missing")
    speaker = resolve_speaker_id(voice, key)
    payload = {"text": text, "speaker": speaker, "emotion": "Neutral"}
    headers = {"Content-Type": "application/json", "x-api-key": key}

    r = requests.post(TOPMEDIA_TTS_API, headers=headers, json=payload, timeout=120)
    r.raise_for_status()

    ct = r.headers.get("content-type", "") or ""
    if "application/json" in ct or ct.startswith("text/"):
        try:
            j = r.json()
        except Exception:
            j = None
        if isinstance(j, dict):
            audio = _find_audio_in_json(j)
            if audio is not None:
                return audio
            raise RuntimeError(f"unexpected TopMediai JSON: {str(j)[:300]}")
        raise RuntimeError(f"unexpected TopMediai JSON type: {type(j)}")

    return r.content

def synthesize_timeline_mp3(lines, out_path: str, voice: str):
    segments, max_end_ms = [], 0
    from io import BytesIO
    for ln in lines:
        audio = topmedia_speak(ln["text"], voice)
        seg = AudioSegment.from_file(BytesIO(audio), format="mp3")
        start_ms = int(ln["start"] * 1000)
        segments.append((start_ms, seg))
        max_end_ms = max(max_end_ms, start_ms + len(seg))
    if not segments:
        raise RuntimeError("no TTS segments")
    timeline = AudioSegment.silent(duration=max_end_ms + 1000)
    for start_ms, seg in segments:
        timeline = timeline.overlay(seg, position=start_ms)
    timeline.export(out_path, format="mp3")
    return out_path

# ------------------------ main ------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--fps", type=int, default=1)
    ap.add_argument("--max_gap", type=int, default=10)
    ap.add_argument("--model", default="gemini-1.5-pro-latest")
    ap.add_argument("--voiceId", default=os.environ.get("TOPMEDIA_VOICE", "ko_female_basic"))
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    out_json = os.path.join(args.outdir, "result.json")
    write_json_atomic(out_json, {"status": "started"})

    try:
        gemini_key = os.environ.get("GEMINI_API_KEY")
        if not gemini_key:
            raise RuntimeError("GEMINI_API_KEY missing")

        R = ResilientGemini(api_key=gemini_key, model_name=args.model, default_timeout=180)

        frames, duration = extract_frames_per_second(args.video, fps=args.fps)
        timeline = get_major_key_events(R, frames)
        timeline = fill_gaps(R, timeline, frames, max_gap=args.max_gap)
        lines = script_from_timeline(R, timeline)
        script_text = "\n".join([l["text"] for l in lines])

        tts_path = os.path.join(args.outdir, "tts.mp3")
        synthesize_timeline_mp3(lines, tts_path, voice=args.voiceId)

        out = {
            "status": "done",
            "timeline": timeline,
            "lines": lines,
            "script": script_text,
            "duration_sec": round(float(duration), 3),
            "tts_path": tts_path,
        }
        write_json_atomic(out_json, out)
        print(json.dumps(out, ensure_ascii=False), flush=True)

    except Exception as e:
        import traceback
        err = {"status": "error", "message": str(e), "trace": traceback.format_exc()}
        write_json_atomic(out_json, err)
        print(json.dumps(err, ensure_ascii=False), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
