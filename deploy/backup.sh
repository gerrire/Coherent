#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_dir="$project_dir/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
umask 077

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$backup_dir/coherent-$timestamp.dump"

if ! docker compose --env-file "$project_dir/deploy/.env" -f "$project_dir/deploy/compose.prod.yaml" exec -T database pg_dump -U coherent -d coherent -Fc > "$backup_file"; then
    rm -f "$backup_file"
    exit 1
fi

if [ -d "$project_dir/data/vapid" ]; then
    tar -C "$project_dir/data" -czf "$backup_dir/coherent-vapid-$timestamp.tar.gz" vapid
fi

# Previous archives included chat files and could outlive their three-day retention.
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-files-*.tar.gz' -delete
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-*.dump' -mtime +7 -delete
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-vapid-*.tar.gz' -mtime +7 -delete
