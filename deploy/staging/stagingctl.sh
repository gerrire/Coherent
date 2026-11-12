#!/bin/bash
set -euo pipefail
umask 077

account=coherent-stage
home=/var/lib/coherent-staging
config=/etc/coherent-staging
uid=$(id -u "$account")
runtime=/run/user/$uid
current_file=$config/deployed-sha
previous_file=$config/previous-sha
exec 9>/run/lock/coherent-staging.lock
flock -w 5 9

as_stage() (
    cd "$home"
    runuser -u "$account" -- env XDG_RUNTIME_DIR="$runtime" DOCKER_HOST="unix://$runtime/docker.sock" "$@"
)

compose() {
    local version=$1
    shift
    as_stage env STAGING_IMAGE_TAG="$version" docker compose --env-file "$home/stack/.env" -f "$home/stack/compose.yaml" "$@"
}

record() {
    printf '%s\n' "$2" >"$1.tmp"
    mv "$1.tmp" "$1"
}

activate() {
    compose "$1" up -d --wait --wait-timeout 120 --no-build --pull never
}

reviewed_ci() {
    python3 - "$1" <<'PY'
import json
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen

commit = sys.argv[1]
query = urlencode({"branch": "Gleb_test", "head_sha": commit, "event": "push", "status": "success"})
url = "https://api.github.com/repos/gerrire/Coherent/actions/workflows/build-deploy.yml/runs?" + query
with urlopen(Request(url, headers={"User-Agent": "Coherent-staging-operator"}), timeout=15) as response:
    runs = json.load(response)["workflow_runs"]
if not any(run["head_sha"] == commit and run["head_branch"] == "Gleb_test" and
           run["event"] == "push" and run["conclusion"] == "success" for run in runs):
    raise SystemExit("No successful Gleb_test push build for this commit")
PY
}

[[ -S $runtime/docker.sock && -f $current_file ]]
current=$(<"$current_file")
[[ $current =~ ^[0-9a-f]{40}$ ]]

case "${1:-}" in
    status)
        printf 'Current: %s\n' "$current"
        if [[ -s $previous_file ]]; then printf 'Previous: %s\n' "$(<"$previous_file")"; fi
        compose "$current" ps
        ;;
    logs)
        shift
        compose "$current" logs --tail 100 "$@"
        ;;
    start)
        activate "$current"
        ;;
    stop)
        compose "$current" stop
        ;;
    restart)
        compose "$current" restart
        activate "$current"
        ;;
    chat-mode)
        [[ $# == 2 ]]
        case "$2" in
            cloud) mode=cloud_v1 ;;
            mls) mode=legacy_mls ;;
            *) echo 'Expected cloud or mls' >&2; exit 2 ;;
        esac
        compose "$current" exec -T postgres psql -U coherent -d coherent_staging -v ON_ERROR_STOP=1 -v "mode=$mode" <<'SQL'
UPDATE chat_policy SET write_mode = :'mode' WHERE id = 1;
SQL
        ;;
    deploy-reviewed)
        [[ $# == 2 && -f $2 ]] || { echo 'Expected an operator-reviewed, uncompressed git archive' >&2; exit 2; }
        archive=$2
        target=$(git get-tar-commit-id <"$archive")
        [[ $target =~ ^[0-9a-f]{40}$ ]]
        [[ $target != "$current" ]] || exit 0
        reviewed_ci "$target"

        source=$(as_stage mktemp -d "$home/build.XXXXXXXX")
        trap 'as_stage rm -rf -- "$source"' EXIT
        as_stage tar --extract --no-same-owner --no-same-permissions -C "$source" <"$archive"
        as_stage docker build -f "$source/deploy/Dockerfile.api" -t "coherent-api:$target" "$source"
        as_stage docker build -f "$source/deploy/Dockerfile.web" -t "coherent-web:$target" "$source"

        # Schema changes are reviewed for backward compatibility before deploy.
        if compose "$target" run --rm --no-deps api alembic upgrade head && activate "$target"; then
            record "$previous_file" "$current"
            record "$current_file" "$target"
        else
            activate "$current"
            exit 1
        fi
        ;;
    rollback)
        [[ -s $previous_file ]] || { echo 'No previous staging revision has been deployed' >&2; exit 2; }
        previous=$(<"$previous_file")
        [[ $previous =~ ^[0-9a-f]{40}$ ]]
        if activate "$previous"; then
            record "$previous_file" "$current"
            record "$current_file" "$previous"
        else
            activate "$current"
            exit 1
        fi
        ;;
    *)
        echo 'Usage: coherent-staging {status|logs [service]|start|stop|restart|chat-mode cloud|chat-mode mls|deploy-reviewed ARCHIVE|rollback}' >&2
        exit 2
        ;;
esac
