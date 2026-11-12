#!/bin/bash
set -euo pipefail
umask 077

account=coherent-stage
stage=/var/lib/coherent-staging
disk=/var/lib/coherent-staging-disk.img
cfg=/etc/coherent-staging
source_dir=$(realpath "${1:?reviewed source directory}")
[[ -d $source_dir/deploy/staging && -f $source_dir/backend/requirements.lock ]]
stage_files=$source_dir/deploy/staging
stage_ip=31.76.77.197
base_sha=179a39c3a7ffb16ac9e03cb501b0c49a2eead0e5
version=${2:?reviewed commit SHA}
[[ $version =~ ^[0-9a-f]{40}$ ]]

if ! id "$account" >/dev/null 2>&1; then
    useradd --no-create-home --home-dir "$stage" --shell /usr/sbin/nologin "$account"
fi
uid=$(id -u "$account")
gid=$(id -g "$account")
subuid=$(awk -F: -v u="$account" '$1 == u && $3 >= 65536 { print $2; exit }' /etc/subuid)
[[ $subuid =~ ^[0-9]+$ ]]
! id -nG "$account" | grep -qwE 'sudo|docker'
install -d -m 0700 "$stage" "$cfg"
if [[ ! -e $disk ]]; then
    available=$(df -B1 --output=avail /var/lib | tail -1)
    (( available >= 12 * 1024 * 1024 * 1024 ))
    truncate -s 7G "$disk"
    chmod 0600 "$disk"
    mkfs.ext4 -q -F -m 0 -L coherent-staging "$disk"
fi
mount_unit=$(systemd-escape --path --suffix=mount "$stage")
install -m 0644 "$stage_files/coherent-staging.mount" "/etc/systemd/system/$mount_unit"
install -d "/etc/systemd/system/user-$uid.slice.d"
cat >"/etc/systemd/system/user-$uid.slice.d/coherent-staging.conf" <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/coherent-staging

[Slice]
CPUQuota=100%
CPUWeight=20
IOWeight=20
MemoryHigh=1100M
MemoryMax=1500M
MemorySwapMax=256M
TasksMax=768
EOF

cat >"$cfg/egress.nft" <<EOF
table inet coherent_stage {
    chain output {
        type filter hook output priority 0; policy accept;
        meta skuid $uid ct state established,related accept
        meta skuid $uid ip daddr 127.0.0.53 udp dport 53 accept
        meta skuid $uid ip daddr 127.0.0.53 tcp dport 53 accept
        meta skuid $uid fib daddr type local reject
        meta skuid $uid meta nfproto ipv6 reject
        meta skuid $uid ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } reject
        meta skuid $uid tcp dport != { 53, 80, 443 } reject
    }
}
EOF
cat >/etc/systemd/system/coherent-staging-egress.service <<EOF
[Unit]
Description=Block staging access to VPS and private networks
Before=user@$uid.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $cfg/egress.nft
ExecStop=-/usr/sbin/nft delete table inet coherent_stage

[Install]
WantedBy=multi-user.target
EOF
install -d "/etc/systemd/system/user@$uid.service.d"
cat >"/etc/systemd/system/user@$uid.service.d/coherent-staging.conf" <<EOF
[Unit]
Requires=coherent-staging-egress.service $mount_unit
After=coherent-staging-egress.service $mount_unit
EOF
systemctl daemon-reload
nft -c -f "$cfg/egress.nft"
systemctl enable --now "$mount_unit" coherent-staging-egress.service
mountpoint -q "$stage"
chown "$uid:$gid" "$stage"
chmod 0700 "$stage"
loginctl enable-linger "$account"
systemctl start "user@$uid.service"

runtime=/run/user/$uid
as_stage() (
    cd "$stage"
    runuser -u "$account" -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" DOCKER_HOST="unix://$runtime/docker.sock" "$@"
)
if [[ ! -S $runtime/docker.sock ]]; then
    as_stage dockerd-rootless-setuptool.sh install --force
fi
as_stage docker info --format '{{json .SecurityOptions}}' | grep -q rootless
as_stage docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}' | grep -qx 'systemd 2'
if as_stage timeout 3 curl -sS -o /dev/null http://127.0.0.1:8000/api/v1/health/ready; then
    echo "Staging user can reach production API" >&2
    exit 1
fi

install -d -o "$uid" -g "$gid" -m 0700 "$stage/stack"
for file in Caddyfile compose.yaml; do
    install -o "$uid" -g "$gid" -m 0600 "$stage_files/$file" "$stage/stack/$file"
done
# Caddy in the rootless container sees its daemon owner as root.
chmod 0644 "$stage/stack/Caddyfile"
if [[ ! -f $stage/stack/.env ]]; then
    {
        printf 'STAGING_SECRET_KEY=%s\n' "$(openssl rand -hex 32)"
        printf 'STAGING_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'STAGING_LIVEKIT_KEY=stage%s\n' "$(openssl rand -hex 10)"
        printf 'STAGING_LIVEKIT_SECRET=%s\n' "$(openssl rand -hex 32)"
    } >"$stage/stack/.env"
    chown "$uid:$gid" "$stage/stack/.env"
fi
if [[ ! -f $stage/stack/master-key ]]; then
    openssl rand 32 >"$stage/stack/master-key"
    chown "$((subuid+10000)):$((subuid+10000))" "$stage/stack/master-key"
fi
chmod 0600 "$stage/stack/master-key"

compose() {
    as_stage env STAGING_IMAGE_TAG="$version" docker compose --env-file "$stage/stack/.env" -f "$stage/stack/compose.yaml" "$@"
}
compose config --quiet

# Use the existing immutable frontend on the first deployment. This commit
# changes server configuration only. Saving an image copies layers, no volumes.
docker image save "coherent-web:$base_sha" | as_stage docker image load
as_stage docker image tag "coherent-web:$base_sha" "coherent-web:$version"
as_stage docker image rm "coherent-web:$base_sha" >/dev/null

# The rootless build sees only a reviewed source archive in its own filesystem.
install -d -o "$uid" -g "$gid" -m 0700 "$stage/source"
tar -C "$source_dir" -cf - backend deploy .dockerignore | as_stage tar -C "$stage/source" -xf -
as_stage docker build -f "$stage/source/deploy/Dockerfile.api" -t "coherent-api:$version" "$stage/source"
compose pull postgres redis livekit mailpit
for volume in attachments vapid; do
    name=coherent-staging_$volume
    as_stage docker volume create "$name" >/dev/null
    as_stage docker run --rm --network none --user 0:0 -v "$name:/volume" "coherent-api:$version" chown 10001:10001 /volume
done
compose up -d --wait postgres redis mailpit
compose run --rm --no-deps api alembic upgrade head
compose up -d --wait
printf '%s\n' "$version" >"$cfg/deployed-sha"

if [[ ! -s $cfg/access ]]; then
    openssl rand -hex 20 >"$cfg/access"
fi
password_hash=$(docker exec -i coherent-web-1 caddy hash-password <"$cfg/access")
sed "s|@STAGING_ACCESS_HASH@|$password_hash|" "$stage_files/proxy.Caddyfile" >"$cfg/proxy.Caddyfile"
install -m 0755 "$stage_files/refresh-proxy.sh" /usr/local/sbin/coherent-staging-refresh-proxy
install -m 0644 "$stage_files/coherent-staging-proxy.service" "$stage_files/coherent-staging-proxy.timer" /etc/systemd/system/
ufw allow in on ens3 to "$stage_ip" port 17881 proto tcp comment 'Coherent staging ICE TCP'
ufw allow in on ens3 to "$stage_ip" port 17882 proto udp comment 'Coherent staging ICE UDP'
ufw allow in on ens3 to "$stage_ip" port 13478 proto udp comment 'Coherent staging TURN UDP'
systemctl daemon-reload
systemctl start coherent-staging-proxy.service
systemctl enable --now coherent-staging-proxy.timer
compose ps
