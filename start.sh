#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.data/app-data-mcp.pid"
LOG_FILE="$ROOT_DIR/app-data-mcp.log"

cd "$ROOT_DIR"
mkdir -p "$(dirname "$PID_FILE")"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "app-data-mcp is already running. pid=$PID"
    echo "log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup npm run dev:http > "$LOG_FILE" 2>&1 &
PID="$!"
echo "$PID" > "$PID_FILE"

echo "app-data-mcp started. pid=$PID"
echo "log: $LOG_FILE"
