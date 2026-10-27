#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_dir="$project_dir/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
umask 077

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$backup_dir/coherent-$timestamp.dump"
partial_file="$backup_file.partial"

if ! docker compose --env-file "$project_dir/deploy/.env" -f "$project_dir/deploy/compose.prod.yaml" exec -T database pg_dump -U coherent -d coherent -Fc > "$partial_file"; then
    rm -f "$partial_file"
    exit 1
fi
mv "$partial_file" "$backup_file"

if [ -d "$project_dir/data/vapid" ]; then
    tar -C "$project_dir/data" -czf "$backup_dir/coherent-vapid-$timestamp.tar.gz" vapid
fi

# Previous archives included chat files and could outlive their three-day retention.
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-files-*.tar.gz' -delete
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-*.dump' -mtime +7 -delete
find "$backup_dir" -maxdepth 1 -type f -name 'coherent-vapid-*.tar.gz' -mtime +7 -delete

# Machine-readable operational status contains no credentials or backup contents.
status_dir="$project_dir/data/operations"
mkdir -p "$status_dir"
chmod 755 "$status_dir"
BACKUP_REPORT_FILE="$backup_file" BACKUP_REPORT_DIR="$status_dir" python3 - <<'REPORT'
import json,os
from pathlib import Path
from datetime import UTC,datetime
backup=Path(os.environ["BACKUP_REPORT_FILE"])
status=Path(os.environ["BACKUP_REPORT_DIR"])/"backup-status.json"
temporary=status.with_suffix(".tmp")
try: previous=json.loads(status.read_text())
except (OSError,ValueError): previous={}
report={key:previous[key] for key in ('offsite_last_success_at','offsite_bytes','restore_checked_at') if key in previous}
report.update(last_success_at=datetime.now(UTC).isoformat(),bytes=backup.stat().st_size)
temporary.write_text(json.dumps(report))
temporary.chmod(0o644)
temporary.replace(status)
REPORT
