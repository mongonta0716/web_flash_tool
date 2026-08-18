#!/bin/bash
set -e

detect_tailscale_host() {
  local json
  json="$(tailscale status --json --peers=false 2>/dev/null)" || return 1
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r '.Self.DNSName' | sed 's/\.$//'
  else
    echo "$json" | sed -n 's/.*"DNSName": *"\([^"]*\)\.\?".*/\1/p' | head -n1
  fi
}

TAILSCALE_HOST="${TAILSCALE_HOST:-$(detect_tailscale_host)}"
TLS_KEY_PATH="${TLS_KEY_PATH:-.secret/${TAILSCALE_HOST}.key}"
TLS_CERT_PATH="${TLS_CERT_PATH:-.secret/${TAILSCALE_HOST}.crt}"
PORT="${PORT:-8443}"

printf 'Starting web server...\n'
printf 'Tailscale URL: https://%s:%s\n' "$TAILSCALE_HOST" "$PORT"

TLS_KEY_PATH="$TLS_KEY_PATH" \
TLS_CERT_PATH="$TLS_CERT_PATH" \
PORT="$PORT" \
npm start

