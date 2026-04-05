# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget ca-certificates jq git ripgrep fd-find zip unzip \
    procps iproute2 dnsutils file less vim-tiny \
    tesseract-ocr tesseract-ocr-eng \
    python3 python3-venv ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/whisper-venv \
  && /opt/whisper-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY scripts ./scripts
RUN npm run build && npx playwright install --with-deps chromium

# Warm faster-whisper tiny model (CPU int8) so first voice note is not blocked on download.
# Optional BuildKit secret `hf_token` → HF_TOKEN (higher Hugging Face Hub rate limits). Omit or use empty .env HF_TOKEN= for anonymous pulls.
RUN --mount=type=secret,id=hf_token,env=HF_TOKEN,required=false \
    /opt/whisper-venv/bin/python -c \
  "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

RUN mkdir -p /app/agent-data/workspace /app/agent-data/logs

ENV NODE_ENV=production
# npm `openai` package (OpenAI-compatible client; we point it at DeepSeek via DEEPSEEK_BASE_URL) → node-fetch → whatwg-url uses builtin `punycode` (Node 22+ DEP0040); suppress this warning only.
ENV NODE_OPTIONS=--disable-warning=DEP0040
ENV DEEPCLAW_DATA_DIR=/app/agent-data
# Explicit full profile (matches code default when unset; visible in `docker inspect`).
ENV DEEPCLAW_SAFE_MODE=0
ENV DEEPCLAW_VOICE_TRANSCRIPTION=1
ENV DEEPCLAW_WHISPER_PYTHON=/opt/whisper-venv/bin/python

# Short CLI inside the container: `deepclaw doctor` (docker exec does not use ENTRYPOINT).
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/deepclaw \
  && chmod +x /usr/local/bin/deepclaw

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["run", "--channel", "telegram"]
