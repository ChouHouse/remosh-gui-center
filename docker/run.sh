#!/bin/bash
cd /ccp
cat /ccp/title
echo ""

# 創建旗標
mkdir -p flags
CLOUDFLARED_FLAGS="cloudflared"

# 判斷是否有 Cloudflared Env（env 有值時以 env 為準，方便更換 token）
if [ -n "$cloudflared" ]; then
    echo "Initialization cloudflared..."
    printf '%s' "$cloudflared" > "flags/$CLOUDFLARED_FLAGS"
    chmod 600 "flags/$CLOUDFLARED_FLAGS"
fi

# 判斷 Cloudflared 旗標是否存在
if [ -s "flags/$CLOUDFLARED_FLAGS" ]; then
    echo "Starting cloudflared..."
    nohup /ccp/cloudflared-supervisor.sh >/dev/null 2>&1 &
fi

if [ -z "$WEB_PASSWORD" ]; then
    echo "WARNING: WEB_PASSWORD is empty. Set it with -e WEB_PASSWORD=... to protect this site."
fi

echo "Server opened on port ${PORT:-8080}."
cd /app
exec node server/main.js
