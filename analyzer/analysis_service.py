# -------- Resilient Gemini (강화판) --------
import json, time, random
import google.generativeai as genai
from http.client import RemoteDisconnected

def _backoff_sleep(i: int, base: float = 1.0, cap: float = 20.0):
    wait = min(cap, base * (2 ** i)) + random.random()
    time.sleep(wait)

def _clean_json_text(text: str) -> str:
    if not text: return text
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
    if _is_rate_limit(e): return True
    return False

class ResilientGemini:
    """
    - generation_config에 response_mime_type='application/json' 강제
    - 빈 응답/비JSON 응답을 상세 메시지로 raise
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
        # 👉 JSON만 달라고 강제 + 온도 0 (일관성)
        self.model = genai.GenerativeModel(
            model_name=self.model_name,
            generation_config={
                "response_mime_type": "application/json",
                "temperature": 0.0
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

                # 1) 가장 일반: resp.text
                text = (getattr(resp, "text", None) or "").strip()

                # 2) 혹시 text가 비면 candidates에서 추출
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

                # 3) 그래도 비면 상세 오류
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
                    # 인증/권한/클라이언트 오류는 즉시 보고
                    raise
                try: self._reset_client()
                except Exception: pass
                _backoff_sleep(i, base=backoff_base)
        raise RuntimeError(f"generate_json_retry failed: {last_err}")

out = {
    "timeline": timeline,
    "lines": lines,
    "script": script_text,
    "duration_sec": round(float(duration), 3),
    "tts_path": tts_path
}

# 결과를 파일에도 저장 (Node가 fallback으로 읽음)
out_json = os.path.join(args.outdir, "result.json")
with open(out_json, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
    f.flush()
    os.fsync(f.fileno())

# stdout에도 출력 (무버퍼 모드에서 바로 전달)
print(json.dumps(out, ensure_ascii=False), flush=True)
