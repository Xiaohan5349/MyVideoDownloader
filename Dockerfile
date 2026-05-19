FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY helper ./helper

ENV HOST=127.0.0.1
ENV PORT=8765
ENV DOWNLOAD_DIR=/downloads

EXPOSE 8765
CMD ["node", "helper/server.js"]
