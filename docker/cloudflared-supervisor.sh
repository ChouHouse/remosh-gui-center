#!/bin/bash
# 持續運行 cloudflared；每輪重新讀取 token，中斷後 5 秒自動重連。
FLAG="/ccp/flags/cloudflared"
while true; do
    if [ -s "$FLAG" ]; then
        cloudflared_token=$(tr -d '\n\r ' < "$FLAG")
        # token 用環境變數傳入，不會出現在行程清單裡
        TUNNEL_TOKEN="$cloudflared_token" cloudflared tunnel --no-autoupdate run >> /tmp/cloudflared.log 2>&1
    fi
    sleep 5
done
