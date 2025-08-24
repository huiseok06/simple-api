# Node 20 (EOL 아닌 버전)
FROM node:20-bullseye

# OS deps: ffmpeg + python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps (package.json/lock만 먼저 복사 → 캐시 활용)
COPY package*.json ./
RUN npm ci --omit=dev || npm i

# Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# App code
COPY . .

ENV NODE_ENV=production
# Render가 PORT 환경변수를 주입하므로 따로 고정하지 않아도 됩니다.
EXPOSE 3000

# index.js의 "npm start"를 사용
CMD ["npm","start"]
