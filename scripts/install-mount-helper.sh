#!/usr/bin/env bash
# Install the NAS/USB mount helper as a root-owned copy (not a symlink: the repo is
# writable by the service user) plus a sudoers rule for just the commands the web
# app needs: that helper, and rebooting / shutting down the Pi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${1:-$(stat -c %U "$ROOT")}"

sudo install -o root -g root -m 0755 "$ROOT/scripts/miniaturestudio-mount" /usr/local/sbin/miniaturestudio-mount
sudo tee /etc/sudoers.d/miniaturestudio >/dev/null <<EOF
$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/miniaturestudio-mount
$RUN_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff
EOF
sudo chmod 0440 /etc/sudoers.d/miniaturestudio
sudo visudo -cf /etc/sudoers.d/miniaturestudio >/dev/null
# Read the systemd journal for the log window in System (includes libcamera's messages).
getent group systemd-journal >/dev/null && sudo usermod -aG systemd-journal "$RUN_USER"
echo "==> Mount helper, power and journal permissions installed for $RUN_USER"
