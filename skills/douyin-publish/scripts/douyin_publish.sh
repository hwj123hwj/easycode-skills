#!/bin/bash
# douyin_publish.sh — 一条命令发布视频到抖音（ego lite 通道）
# ego-browser nodejs 不接受额外 CLI 参数也不继承环境变量，
# 所以 wrapper 把标志写进临时参数 JSON，sed 注入脚本后走 stdin。
#
# 用法：
#   douyin_publish.sh --healthcheck
#   douyin_publish.sh --params /tmp/douyin_params.json [--dry-run]
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARAMS="/tmp/douyin_params.json"
FLAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --params) PARAMS="$2"; shift 2 ;;
    --healthcheck) FLAGS="healthcheck"; shift ;;
    --dry-run) FLAGS="dry_run"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

TMP=$(mktemp /tmp/douyin_build_XXXXXX.js)
PJSON=$(mktemp /tmp/douyin_p_XXXXXX.json)
trap 'rm -f "$TMP" "$PJSON"' EXIT

# 基础参数：复制用户 JSON（不存在则空对象），再叠加标志
if [ -f "$PARAMS" ]; then cp "$PARAMS" "$PJSON"; else echo '{}' > "$PJSON"; fi
if [ -n "$FLAGS" ]; then
  if command -v jq >/dev/null 2>&1; then
    jq --arg f "$FLAGS" '. + {($f): true}' "$PJSON" > "$PJSON.tmp" && mv "$PJSON.tmp" "$PJSON"
  else
    python3 -c "import json,sys; d=json.load(open('$PJSON')); d['$FLAGS']=True; json.dump(d,open('$PJSON','w'))"
  fi
fi

sed \
  -e "s|const PARAMS_FILE = .*|const PARAMS_FILE = '$PJSON'|" \
  -e "s|const argv = process.argv.slice(2)|const argv = $( [ -n "$FLAGS" ] && echo "['--$FLAGS']" || echo "[]" )|" \
  "$SKILL_DIR/scripts/douyin_publish.js" > "$TMP"

ego-browser nodejs < "$TMP"