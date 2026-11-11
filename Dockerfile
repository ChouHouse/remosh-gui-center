FROM ghcr.io/calou-code-platform/ccp-base-debian:main

LABEL maintainer="caloutw"
LABEL org.opencontainers.image.title="Remosh GUI Center"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.authors="calou code platform"
LABEL org.opencontainers.image.description="[Remosh GUI Center] A web desktop for SSH hosts: files, editor, terminal."

# 存取密碼（必填，進入 SSH 登入畫面前要先輸入）
ENV WEB_PASSWORD=""
# (選填) Cloudflared Tunnel token
ENV cloudflared=""
# (選填) 允許連線的 SSH 主機，逗號分隔；留空表示不限制
ENV ALLOWED_HOSTS=""
ENV PORT=8080
ENV NODE_ENV=production

USER root

# 安裝必要項目與 cloudflared
RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg nodejs npm && \
    mkdir -p --mode=0755 /usr/share/keyrings && \
    curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg -o /usr/share/keyrings/cloudflare-public-v2.gpg && \
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends cloudflared && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 建立應用程式
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY public ./public
# 先裝全部套件來複製 Monaco / xterm 的靜態檔到 public，再移除只在開發時需要的套件
RUN npm ci --no-audit --no-fund && \
    npm run assets && \
    npm prune --omit=dev --no-audit --no-fund && \
    npm cache clean --force
COPY src ./src
COPY server ./server

# 建立工作區域（旗標放這裡，與 remosh 相同）
RUN mkdir -p /ccp/flags
WORKDIR /ccp
COPY docker/run.sh docker/cloudflared-supervisor.sh docker/title ./
RUN chmod +x run.sh cloudflared-supervisor.sh

# 以非 root 身分執行
RUN useradd --system --create-home --home-dir /home/remosh --shell /usr/sbin/nologin remosh && \
    chown -R remosh:remosh /ccp /app
USER remosh

EXPOSE 8080
CMD ["/ccp/run.sh"]
