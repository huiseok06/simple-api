FROM node:20-bullseye

# OS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps (캐시 활용)
COPY package*.json ./
RUN npm ci --omit=dev || npm i

# Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# App code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
