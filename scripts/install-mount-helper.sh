#!/usr/bin/env bash
# Install the NAS mount helper as a root-owned copy (not a symlink: the repo is
# writable by the service user) plus a sudoers rule for just that command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${1:-$(stat -c %U "$ROOT")}"

sudo install -o root -g root -m 0755 "$ROOT/scripts/photoboothcamera-mount" /usr/local/sbin/photoboothcamera-mount
echo "$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/photoboothcamera-mount" | sudo tee /etc/sudoers.d/photoboothcamera >/dev/null
sudo chmod 0440 /etc/sudoers.d/photoboothcamera
sudo visudo -cf /etc/sudoers.d/photoboothcamera >/dev/null
echo "==> NAS mount helper installed for $RUN_USER"
