#!/usr/bin/env bash
# Sender-only SMTP for the existing Coherent Docker network on this Ubuntu VPS.
set -euo pipefail
test "$(id -u)" -eq 0
task_mail_domain=coherent-web.ru
task_mail_host=mail.coherent-web.ru
task_mail_selector=coherent2026
task_mail_gateway=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
task_mail_subnet=$(docker network inspect coherent_default --format '{{(index .IPAM.Config 0).Subnet}}')
task_mail_network_id=$(docker network inspect coherent_default --format '{{.Id}}')
task_mail_bridge="br-${task_mail_network_id:0:12}"
test -n "$task_mail_gateway"
test -n "$task_mail_subnet"
printf '%s\n' "postfix postfix/mailname string $task_mail_domain" "postfix postfix/main_mailer_type select Local only" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postfix opendkim opendkim-tools
cp -n /etc/postfix/main.cf /etc/postfix/main.cf.before-coherent || true
chmod 600 /etc/postfix/main.cf.before-coherent
install -d -o opendkim -g opendkim -m 700 "/etc/opendkim/keys/$task_mail_domain"
if ! test -f "/etc/opendkim/keys/$task_mail_domain/$task_mail_selector.private"; then
    opendkim-genkey -b 2048 -D "/etc/opendkim/keys/$task_mail_domain" -d "$task_mail_domain" -s "$task_mail_selector"
fi
chown opendkim:opendkim "/etc/opendkim/keys/$task_mail_domain/$task_mail_selector.private"
chmod 600 "/etc/opendkim/keys/$task_mail_domain/$task_mail_selector.private"
cat > /etc/opendkim.conf <<EOF
Syslog yes
SyslogSuccess yes
UMask 007
Mode s
Canonicalization relaxed/simple
UserID opendkim
PidFile /run/opendkim/opendkim.pid
OversignHeaders From
Socket inet:8891@127.0.0.1
KeyTable /etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
InternalHosts refile:/etc/opendkim/TrustedHosts
EOF
printf '%s\n' "$task_mail_selector._domainkey.$task_mail_domain $task_mail_domain:$task_mail_selector:/etc/opendkim/keys/$task_mail_domain/$task_mail_selector.private" > /etc/opendkim/KeyTable
printf '%s\n' "noreply@$task_mail_domain $task_mail_selector._domainkey.$task_mail_domain" > /etc/opendkim/SigningTable
printf '%s\n' '127.0.0.1' "$task_mail_subnet" > /etc/opendkim/TrustedHosts
printf '%s\n' "noreply@$task_mail_domain OK" > /etc/postfix/coherent-senders
postmap /etc/postfix/coherent-senders
postconf -e "myhostname = $task_mail_host" "mydomain = $task_mail_domain" "myorigin = $task_mail_domain"
postconf -e "inet_interfaces = 127.0.0.1, $task_mail_gateway" 'inet_protocols = ipv4' 'mydestination = localhost'
postconf -e 'default_transport = smtp' 'relay_transport = smtp' 'relayhost ='
postconf -e "mynetworks = 127.0.0.0/8, $task_mail_subnet" 'mynetworks_style = host'
postconf -e 'smtpd_client_restrictions = permit_mynetworks, reject' 'smtpd_relay_restrictions = permit_mynetworks, reject'
postconf -e 'smtpd_sender_restrictions = check_sender_access hash:/etc/postfix/coherent-senders, reject'
postconf -e 'smtp_tls_security_level = encrypt' 'smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt'
postconf -e 'smtpd_milters = inet:127.0.0.1:8891' 'non_smtpd_milters = inet:127.0.0.1:8891' 'milter_default_action = tempfail' 'milter_protocol = 6'
postconf -e 'message_size_limit = 65536' 'queue_minfree = 2147483648' 'maximal_queue_lifetime = 1h' 'bounce_queue_lifetime = 1h' 'smtp_destination_concurrency_limit = 2' 'default_destination_rate_delay = 1s'
install -d /etc/systemd/system/postfix@-.service.d
cat > /etc/systemd/system/postfix@-.service.d/coherent-docker.conf <<EOF
[Unit]
After=docker.service
Requires=docker.service
EOF
opendkim -n -x /etc/opendkim.conf
postfix check
install -d -o opendkim -g opendkim -m 750 /run/opendkim
systemctl daemon-reload
systemctl enable opendkim postfix
systemctl restart opendkim
systemctl restart postfix
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    ufw allow in on "$task_mail_bridge" from "$task_mail_subnet" to "$task_mail_gateway" port 25 proto tcp comment 'Coherent private SMTP'
fi
printf '%s\n' 'SMTP is private to localhost and the Coherent Docker network. Public DKIM record:'
cat "/etc/opendkim/keys/$task_mail_domain/$task_mail_selector.txt"
