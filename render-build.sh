#!/usr/bin/env bash
set -e
apt-get update
apt-get install -y --no-install-recommends ffmpeg python3 python3-pip
pip3 install --no-cache-dir -r requirements.txt
npm ci --omit=dev || npm i
