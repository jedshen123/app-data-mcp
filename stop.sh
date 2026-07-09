#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.data/app-data-mcp.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "app-data-mcp is not running: pid file not found."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [[ -z "$PID" ]]; then
  rm -f "$PID_FILE"
  echo "app-data-mcp is not running: empty pid file removed."
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "app-data-mcp is not running: stale pid file removed. pid=$PID"
  exit 0
fi

kill "$PID"

for _ in {1..20}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "app-data-mcp stopped. pid=$PID"
    exit 0
  fi
  sleep 0.5
done

echo "app-data-mcp did not stop gracefully, sending SIGKILL. pid=$PID"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "app-data-mcp stopped. pid=$PID"
