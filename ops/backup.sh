#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${ROOT_DIR}/data"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${DATA_DIR}/backups/${STAMP}"

mkdir -p "${OUT_DIR}"
cp "${DATA_DIR}/app.db" "${OUT_DIR}/app.db"

tar -C "${DATA_DIR}" -czf "${OUT_DIR}/blobs.tar.gz" blobs

echo "Backup created: ${OUT_DIR}"
