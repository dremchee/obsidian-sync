#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup-dir>"
  exit 1
fi

BACKUP_DIR="$1"

[[ -f "${BACKUP_DIR}/app.db" ]] || { echo "Missing app.db"; exit 1; }
[[ -f "${BACKUP_DIR}/blobs.tar.gz" ]] || { echo "Missing blobs.tar.gz"; exit 1; }

echo "Backup looks valid: ${BACKUP_DIR}"
