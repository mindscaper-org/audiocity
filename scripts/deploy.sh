#!/bin/sh
set -eu

# Included in the versioned deployment bundle by npm run package.
cd -- "$(dirname -- "$0")"
command -v docker >/dev/null 2>&1 || { echo 'Install Docker with Compose first.' >&2; exit 1; }
docker compose version >/dev/null
docker compose up -d --wait
echo 'Audiocity started. Open http://localhost:8080 (or your configured URL).'
echo 'Run docker compose logs audiocity to get the first-run administrator password.'
