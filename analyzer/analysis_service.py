# analyzer/analysis_service.py  (요약: 이전 완전판과 동일 + --lines_path 지원)
# ... (상단 import/유틸/ResilientGemini/파이프라인/TopMediai TTS는 이전 답변의 "완전판" 그대로) ...

def synthesize_timeline_mp3(lines, out_path: str, voice: str):
    # (이전 완전판 동일)
    from io import BytesIO
    segments, max_end_ms = [], 0
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
    ap.add_argument("--video")  # lines_path 모드에서는 optional
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--fps", type=int, default=1)
    ap.add_argument("--max_gap", type=int, default=10)
    ap.add_argument("--model", default="gemini-1.5-pro-latest")
    ap.add_argument("--voiceId", default=os.environ.get("TOPMEDIA_VOICE", "ko_female_basic"))
    ap.add_argument("--lines_path")  # ← 추가: 라인 JSON 주면 재합성만
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    out_json = os.path.join(args.outdir, "result.json")
    write_json_atomic(out_json, {"status": "started"})

    try:
        # 재합성 모드: lines만 가지고 TTS 만들기
        if args.lines_path:
            if not os.path.exists(args.lines_path):
                raise RuntimeError("lines_path not found")
            with open(args.lines_path, "r", encoding="utf-8") as f:
                lines = json.load(f)
            tts_path = os.path.join(args.outdir, "tts.mp3")
            synthesize_timeline_mp3(lines, tts_path, voice=args.voiceId)
            # 기존 result.json 유지 + tts_path만 업데이트
            base = {}
            if os.path.exists(out_json):
                try:
                    base = json.load(open(out_json, "r", encoding="utf-8"))
                except Exception:
                    base = {}
            base.update({"status": "done", "tts_path": tts_path})
            write_json_atomic(out_json, base)
            print(json.dumps(base, ensure_ascii=False), flush=True)
            return

        # 분석 모드(비전 + 제미니 + TTS)
        if not args.video:
            raise RuntimeError("video required when lines_path not provided")
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
