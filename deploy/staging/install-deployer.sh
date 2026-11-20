#!/bin/bash
# Install reviewed deployment tools without replacing the running stack or secrets.
set -euo pipefail
umask 077
[[ $EUID == 0 ]]
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -s /etc/coherent-staging/deployed-sha ]]
backup=$(mktemp -d /etc/coherent-staging/deployer-backup.XXXXXXXX)
for file in /usr/local/sbin/coherent-staging /usr/local/sbin/coherent-staging-auto \
            /etc/systemd/system/coherent-staging-auto.service \
            /etc/systemd/system/coherent-staging-auto.timer; do
    if [[ -f $file ]]; then cp -a -- "$file" "$backup/"; fi
done
if [[ -d /usr/local/lib/coherent-staging ]]; then
    cp -a /usr/local/lib/coherent-staging "$backup/lib"
fi
systemctl stop coherent-staging-auto.timer coherent-staging-auto.service
install -d -m 0755 /usr/local/lib/coherent-staging
install -m 0755 "$source_dir/images.py" /usr/local/lib/coherent-staging/images.py
install -m 0755 "$source_dir/stagingctl.sh" /usr/local/sbin/coherent-staging
install -m 0755 "$source_dir/auto-deploy.py" /usr/local/sbin/coherent-staging-auto
install -m 0644 "$source_dir/coherent-staging-auto.service" \
    "$source_dir/coherent-staging-auto.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now coherent-staging-auto.timer
printf 'Installed prebuilt-image staging deployer. Backup: %s\n' "$backup"
