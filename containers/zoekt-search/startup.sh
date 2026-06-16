#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME is required}"

prefix="${R2_BUCKET_PREFIX:-zoekt}"
sync_interval="${ZOEKT_R2_SYNC_INTERVAL_SECONDS:-60}"
index_dir="/var/lib/zoekt-index"

mkdir -p "${index_dir}"
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo "Configuring R2 source ${R2_BUCKET_NAME}/${prefix}"
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_R2_ENDPOINT="${endpoint}"

sync_index() {
  rclone sync "r2:${R2_BUCKET_NAME}/${prefix}" "${index_dir}" \
    --fast-list \
    --transfers 8 \
    --checkers 16
}

echo "Syncing initial Zoekt index into ${index_dir}"
sync_index

(
  while sleep "${sync_interval}"; do
    sync_index || echo "Zoekt R2 sync failed; keeping previous local index"
  done
) &

echo "Starting zoekt-webserver with index ${index_dir}"
exec zoekt-webserver -index "${index_dir}" -listen ":6070"
