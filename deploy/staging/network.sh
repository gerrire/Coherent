#!/bin/bash
set -euo pipefail

name=coherent-stage
link=coh-stage-host
gateway=10.205.40.1
guest=10.205.40.2
uid=$(id -u coherent-stage)
runtime=/run/user/$uid
exec 9>/run/lock/coherent-staging-network.lock
flock -w 10 9

case "${1:?start or stop}" in
    start)
        [[ $(sysctl -n net.ipv4.ip_forward) == 1 ]]
        systemctl start "user@$uid.service"
        pid_file=$runtime/dockerd-rootless/child_pid
        for attempt in $(seq 1 30); do
            [[ -S $runtime/docker.sock && -s $pid_file ]] && break
            sleep 1
        done
        pid=$(<"$pid_file")
        [[ $pid =~ ^[0-9]+$ && $(stat -c %u "/proc/$pid") == "$uid" ]]
        grep -Fq "/user.slice/user-$uid.slice/user@$uid.service/" "/proc/$pid/cgroup"
        namespace=$(stat -Lc %i "/proc/$pid/ns/net")
        [[ $namespace != "$(stat -Lc %i /proc/1/ns/net)" ]]

        if [[ -e /run/netns/$name && $(stat -Lc %i "/run/netns/$name") == "$namespace" ]] &&
           ip link show "$link" >/dev/null 2>&1 &&
           nft list table inet coherent_stage_net >/dev/null 2>&1; then
            exit 0
        fi
        if nft list table inet coherent_stage_net >/dev/null 2>&1; then
            { echo 'delete table inet coherent_stage_net'; cat /etc/coherent-staging/media.nft; } | nft -f -
        else
            nft -f /etc/coherent-staging/media.nft
        fi
        if [[ -e /run/netns/$name && $(stat -Lc %i "/run/netns/$name") != "$namespace" ]]; then
            ip link del "$link" 2>/dev/null || true
            ip netns del "$name"
        fi
        if [[ ! -e /run/netns/$name ]]; then
            ip netns attach "$name" "$pid"
            [[ $(stat -Lc %i "/run/netns/$name") == "$namespace" ]]
            ip link add "$link" type veth peer name eth0 netns "$name"
            ip addr add "$gateway/30" dev "$link"
            ip link set "$link" up
            ip -n "$name" addr add "$guest/30" dev eth0
            ip -n "$name" link set lo up
            ip -n "$name" link set eth0 up
            ip -n "$name" route replace default via "$gateway"
        fi
        ip -n "$name" route get 1.1.1.1 >/dev/null
        if [[ -s /etc/coherent-staging/deployed-sha ]]; then
            /usr/local/sbin/coherent-staging start
        fi
        ;;
    stop)
        ip link del "$link" 2>/dev/null || true
        ip netns del "$name" 2>/dev/null || true
        nft delete table inet coherent_stage_net 2>/dev/null || true
        ;;
    *) exit 2 ;;
esac
