# --- deps stage: installs dependencies, compiles better-sqlite3's native binding
FROM node:26-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# --- runtime stage
FROM node:26-alpine
# Use pip to install yt-dlp (wget zipapp is unreliable on Alpine/musl).
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip3 install --break-system-packages yt-dlp
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /app/videos /app/db

ENV NODE_ENV=production
ENV PORT=4000
ENV VIDEOS_DIR=/app/videos
ENV DB_PATH=/app/db/data.sqlite
ENV FFMPEG_PATH=ffmpeg
ENV YTDLP_PATH=yt-dlp

EXPOSE 4000
CMD ["node", "server.js"]
