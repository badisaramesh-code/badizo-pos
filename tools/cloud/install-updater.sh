#!/bin/sh
set -eu
test "$(id -u)" = 0
base=/var/lib/badizo-cloud-update
install -d -m 0755 "$base" /usr/local/lib/badizo /etc/systemd/system/badizo-pos.service.d
install -d -o badizo -g badizo -m 0750 "$base/inbox"
install -o root -g root -m 0755 "$(dirname "$0")/update.py" /usr/local/lib/badizo/update.py
if [ ! -e "$base/state.json" ]; then
  printf '%s\n' '{"phase":"idle","commit":null}' > "$base/state.json"
fi
cat >/etc/systemd/system/badizo-pos.service.d/80-cloud-release.conf <<'UNIT'
[Service]
EnvironmentFile=-/etc/badizo/release.env
ReadWritePaths=/var/lib/badizo-cloud-update/inbox
UNIT
cat >/etc/systemd/system/badizo-cloud-update.service <<'UNIT'
[Unit]
Description=Install and verify a requested Badizo cloud standby release
After=network-online.target badizo-pos.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/badizo/update.py
TimeoutStartSec=15min
PrivateTmp=true
ProtectHome=true
NoNewPrivileges=true
UNIT
cat >/etc/systemd/system/badizo-cloud-update.path <<'UNIT'
[Unit]
Description=Watch for an owner-requested Badizo cloud update
[Path]
PathExists=/var/lib/badizo-cloud-update/inbox/request
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now badizo-cloud-update.path
