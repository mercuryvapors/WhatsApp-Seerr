# WhatsApp Seerr Bridge - Dockerfile
FROM node:20-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=false

# Shared libraries and fonts needed by Puppeteer's Chrome.
# Do NOT install the distro chromium: whatsapp-web.js 1.34.x is tested
# against Puppeteer's own Chrome for Testing build (downloaded at npm install).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY src/ src/
COPY public/ public/

ENV DATA_DIR=/data

RUN mkdir -p /data && chmod 777 /data

VOLUME ["/data"]

# /dev/shm: Docker defaults to 64MB which crashes Chromium's renderer
# ("Navigating frame was detached"). Shrunk by disabling dev-shm usage,
# but prefer passing --shm-size=1gb when running the container.
EXPOSE 7000

ENV PORT=7000

CMD ["dumb-init", "node", "src/index.js"]