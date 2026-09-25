#!/usr/bin/env bash
# Installs, builds and starts the stdio MCP server for cloud sessions and routines.
# stdout is the MCP JSON-RPC channel: everything before the final exec writes to stderr only.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "[mcp-cloud] cannot cd to repo root" >&2; exit 1; }

if [ ! -f node_modules/.package-lock.json ]; then
  echo "[mcp-cloud] installing dependencies (npm ci)" >&2
  if ! npm ci --include=dev --no-audit --no-fund </dev/null >&2; then
    echo "[mcp-cloud] npm ci failed; see output above" >&2
    exit 1
  fi
fi

echo "[mcp-cloud] building (npm run build)" >&2
if ! npm run build </dev/null >&2; then
  echo "[mcp-cloud] npm run build failed; see output above" >&2
  exit 1
fi

exec node dist/index.js
