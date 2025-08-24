# analyzer/analysis_service.py
# 런타임 의존성:
#   - apt: ffmpeg, python3, python3-pip
#   - pip: opencv-python-headless pillow numpy pydub requests google-generativeai
# 환경 변수:
#   - GEMINI_API_KEY (필수)
#   - TOPMEDIA_API_KEY (필수)
#   - [옵션] TOPMEDIA_API_URL, TOPMEDIA_AUTH_STYLE("Bearer" | "x-api-key"), TOPMEDIA_VOICE

import os, sys, json, time, argparse, tempfile, random
from http.client import RemoteDisconnected

import cv2
import numpy as np
from PIL import Image
import requests
from pydub import AudioSegment
import google.generativeai as genai


# ------------------------ 공통 유틸 ------------------------

def write_json_atomic(path: str, obj: dict):
    """결과 JSON을 원자적으로 기록(빈 파일 방지)."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic replace


def _backoff_sleep(i: int, base: float = 1.0, cap: float = 20.0):
    wait = min(cap, base * (2 ** i)) + random.random()
    time.sleep(wait)


def _clean_json_text(text: str) -> str:
    if not text:
        return text
    t = text.strip().replace("```json", "").replace("```", "").strip()
    return t


def _is_rate_limit(e: Exception) -> bool:
    s = str(e).lower()
    return any(k in s for k in ["429", "rate limit", "quota", "resource exhausted"])


def _should_retry_exception(e: Exception) -> bool:
    if isinstance(e, (ConnectionError, TimeoutError, RemoteDisconnected, ConnectionResetError)):
        return True
    s = str(e).lower()
    if any(k in s for k in ["connection", "timeout", "protocol", "chunked"]):
        return True
    if _is_rate_limit(e):
        return True
    return False


# ------------------------ Gemini 래퍼(강화판) ------------------------

class ResilientGemini:
    """
    - response_mime_type='application/json' 강제
    - 빈 응답/비JSON 응답에 대해 상세한 예외 메시지
    - 업로드/생성 재시도 + 백오프
    """
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
            generation_config={
                "response_mime_type": "application/json",
                "temperature": 0.0,
            }
        )

    def upload_file_retry(self, path: str, mime_type: str = None, retries=6, backoff_base=1.0):
        last_err = None
        for i in range(retries):
            try:
                f = genai.upload_file(path, mime_type=mime_type)
                name = getattr(f, "name", None)
                if not name:
                    return f
                # ACTIVE 될 때까지 폴링
                for _ in range(self.max_polls):
                    g = genai.get_file(name)
                    state = getattr(getattr(g, "state", None), "name", None) or getattr(g, "state", None)
                    if str(state).upper() == "ACTIVE":
                        return g
                    time.sleep(self.poll_interval)
                return g
            except Exception as e:
                last_err = e
                if not _should_retry_exception(e):
                    raise
                try:
                    self._reset_client()
                except Exception:
                    pass
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
                    # candidates에서 끌어오기
                    try:
                        cands = getattr(resp, "candidates", None) or []
                        if cands and getattr(cands[0], "content", None):
                            pieces = []
                            for p in (cands[0].content.parts or []):
                                t = getattr(p, "text", None)
                                if t:
                                    pieces.append(t)
                            text = "".join(pieces).strip()
                    except Exception:
                        pass

                if not text:
                    pf = getattr(resp, "prompt_feedback", None)
                    raise RuntimeError(
                        f"Gemini returned empty response. "
                        f"Check GEMINI_API_KEY / quota / safety. prompt_feedback={pf}"
                    )

                cleaned = _clean_json_text(text)
                try:
                    return json.loads(cleaned)
                except Exception as je:
                    preview = cleaned[:400]
                    raise RuntimeError(f"Gemini non-JSON response preview: {preview}") from je

            except Exception as e:
                last_err = e
                if not _should_retry_exception(e):
                    raise
                try:
                    self._reset_client()
                except Exception:
                    pass
                _backoff_sleep(i, base=backoff_base)
        raise RuntimeError(f"generate_json_retry failed: {last_err}")


# ------------------------ 분석 파이프라인 ------------------------

def extract_frames_per_second(video_path: str, fps: int = 1):
    """비디오에서 초당 1 프레임씩 추출(짧은 변 480px로 축소)."""
    temp_dir = tempfile.mkdtemp(prefix="frames_")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("비디오를 열 수 없습니다.")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    vid_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    duration_sec = (total_frames / max(vid_fps, 1e-6)) if total_frames else 0.0

    step = max(int(vid_fps / max(fps, 1)), 1)
    frames = []
    i = 0
    t = 0.0
    while True:
        ret = cap.grab()
        if not ret:
            break
        if i % step == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                h, w = frame.shape[:2]
                if h > 0:
                    scale = 480 / h
                    small = cv2.resize(frame, (int(w * scale), int(h * scale)))
                else:
                    small = frame
                path = os.path.join(temp_dir, f"frame_{int(t)}.jpg")
                cv2.imwrite(path, small)
                frames.append({"path": path, "time": int(t)})
        i += 1
        t = i / max(vid_fps, 1e-6)
    cap.release()
    return frames, float(duration_sec)


def get_major_key_events(R: ResilientGemini, frames):
    """주요 하이라이트 타임라인 추출."""
    if not frames:
        return []

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
    events = []
    seen = set()
    for e in js:
        try:
            st = int(max(0, round(float(e.get("start", 0)))))
            desc = str(e.get("event_description", "")).strip()
        except Exception:
            continue
        if st in seen:
            continue
        seen.add(st)
        events.append({"start": st, "event_description": desc or "주요 하이라이트"})
    events.sort(key=lambda x: x["start"])

    # 안전장치: 비어있으면 5초 간격으로 최소 1개 생성
    if not events and frames:
        t0 = frames[0]["time"]
        t1 = frames[-1]["time"]
        mid = int((t0 + t1) // 2)
        events = [{"start": max(0, mid), "event_description": "주요 하이라이트"}]
    return events


def fill_gaps(R: ResilientGemini, timeline, frames, max_gap=10):
    """긴 공백 구간을 보조 사건으로 채움."""
    if not timeline:
        return []
    out = []
    timeline = sorted(timeline, key=lambda x: x["start"])
    for i, cur in enumerate(timeline):
        out.append(cur)
        if i == len(timeline) - 1:
            break
        nxt = timeline[i + 1]
        gap = int(nxt["start"] - cur["start"])
        if gap > max_gap:
            gap_frames = [f for f in frames if cur["start"] < f["time"] < nxt["start"]]
            if not gap_frames:
                # 균등 분할 fallback
                n = max(1, gap // 7)
                step = gap / (n + 1)
                for k in range(n):
                    st = int(round(cur["start"] + (k + 1) * step))
                    out.append({"start": st, "event_description": "중간 하이라이트"})
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
                # 완전 실패 시에도 균등 분할
                n = max(1, gap // 7)
                step = gap / (n + 1)
                for k in range(n):
                    st = int(round(cur["start"] + (k + 1) * step))
                    out.append({"start": st, "event_description": "중간 하이라이트"})
    # start 중복 제거
    tmp = {e["start"]: e for e in out}
    return sorted(tmp.values(), key=lambda x: x["start"])


def script_from_timeline(R: ResilientGemini, timeline):
    """각 사건에 맞는 해설 대사 + rate 생성."""
    if not timeline:
        return []
    lines = []
    for i, cur in enumerate(timeline):
        available = (timeline[i + 1]["start"] - cur["start"]) if i < len(timeline) - 1 else 8
        if available <= 0:
            continue
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
            # 실패 시 최소 텍스트라도 생성
            lines.append({"id": f"e{i}", "start": int(cur["start"]), "text": cur["event_description"], "rate": 1.0})
    return lines


# ------------------------ TopMediaAI TTS ------------------------

def topmedia_speak(text: str, voice: str) -> bytes:
    api = os.environ.get("TOPMEDIA_API_URL", "https://api.topmediai.com/v1/tts")
    key = os.environ.get("TOPMEDIA_API_KEY", "")
    style = (os.environ.get("TOPMEDIA_AUTH_STYLE", "Bearer")).lower()
    if not key:
        raise RuntimeError("TOPMEDIA_API_KEY missing")
    payload = {"text": text, "voice": voice, "format": "mp3"}

    h_bearer = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    h_xkey = {"Content-Type": "application/json", "x-api-key": key}

    def try_once(headers):
        r = requests.post(api, headers=headers, json=payload, timeout=60)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "application/json" in ct:
            j = r.json()
            if "url" in j:
                r2 = requests.get(j["url"], timeout=60)
                r2.raise_for_status()
                return r2.content
            if "audioContent" in j:  # base64
                import base64
                return base64.b64decode(j["audioContent"])
            raise RuntimeError("unexpected JSON from TTS")
        return r.content

    try:
        return try_once(h_bearer if style.startswith("bearer") else h_xkey)
    except Exception as e1:
        try:
            return try_once(h_xkey if style.startswith("bearer") else h_bearer)
        except Exception as e2:
            raise RuntimeError(f"TopMediaAI failed: {e1} / {e2}")


def synthesize_timeline_mp3(lines, out_path: str, voice: str):
    """각 줄을 개별로 합성해 start초에 맞춰 오버레이 → 하나의 mp3."""
    segments = []
    max_end_ms = 0
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

    # 시작 상태 기록(디버그용)
    write_json_atomic(out_json, {"status": "started"})

    try:
        gemini_key = os.environ.get("GEMINI_API_KEY")
        if not gemini_key:
            raise RuntimeError("GEMINI_API_KEY missing")

        R = ResilientGemini(api_key=gemini_key, model_name=args.model, default_timeout=180)

        # 1) 프레임 추출
        frames, duration = extract_frames_per_second(args.video, fps=args.fps)

        # 2) 하이라이트 타임라인
        timeline = get_major_key_events(R, frames)
        timeline = fill_gaps(R, timeline, frames, max_gap=args.max_gap)

        # 3) 대본 생성
        lines = script_from_timeline(R, timeline)
        script_text = "\n".join([l["text"] for l in lines])

        # 4) TTS 스티칭
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

        # 결과 저장 + stdout 출력
        write_json_atomic(out_json, out)
        print(json.dumps(out, ensure_ascii=False), flush=True)

    except Exception as e:
        import traceback
        err = {
            "status": "error",
            "message": str(e),
            "trace": traceback.format_exc(),
        }
        write_json_atomic(out_json, err)
        print(json.dumps(err, ensure_ascii=False), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
