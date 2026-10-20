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

find "$backup_dir" -maxdepth 1 -type f -name 'coherent-*.dump' -mtime +7 -delete
