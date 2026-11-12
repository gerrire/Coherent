#!/bin/bash
set -euo pipefail

exec 9>/run/lock/coherent-deploy.lock
flock -w 10 9 || exit 0
stage=/etc/coherent-staging/proxy.Caddyfile
container=$(docker inspect -f '{{if .State.Running}}{{.Id}}{{end}}' coherent-web-1)
[[ -n $container ]] || exit 0
marker=/run/coherent-staging-proxy-state
digest=$(sha256sum "$stage")
stamp="$container $digest"
[[ ! -f $marker || $(<"$marker") != "$stamp" ]] || exit 0

config=$(mktemp)
trap 'rm -f -- "$config"' EXIT
docker exec "$container" cat /etc/caddy/Caddyfile >"$config"
printf '\n' >>"$config"
cat "$stage" >>"$config"
docker exec -i "$container" caddy validate --adapter caddyfile --config /dev/stdin <"$config"
docker exec -i "$container" caddy reload --adapter caddyfile --config /dev/stdin <"$config"
printf '%s\n' "$stamp" >"$marker"
