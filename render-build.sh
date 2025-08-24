#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends ffmpeg python3 python3-pip
python3 -V

pip3 install --no-cache-dir --upgrade pip
pip3 install --no-cache-dir -r requirements.txt

# 설치 검증 (빌드 로그에서 'PY OK'가 보이면 성공)
python3 - <<'PY'
import cv2, numpy, PIL, requests, pydub, google.generativeai
print("PY OK", cv2.__version__, numpy.__version__)
PY

# Node deps
npm ci --omit=dev || npm i
