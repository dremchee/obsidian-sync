#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:3243}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
DRY_RUN="${DRY_RUN:-true}"

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "ADMIN_TOKEN is required"
  exit 1
fi

curl -sS -X POST "${API_URL}/api/v1/admin/gc" \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"dryRun\": ${DRY_RUN}}"

echo
