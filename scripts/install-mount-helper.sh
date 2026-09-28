#!/usr/bin/env bash
# Install the NAS mount helper as a root-owned copy (not a symlink: the repo is
# writable by the service user) plus a sudoers rule for just that command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${1:-$(stat -c %U "$ROOT")}"

sudo install -o root -g root -m 0755 "$ROOT/scripts/minicamera-mount" /usr/local/sbin/minicamera-mount
echo "$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/minicamera-mount" | sudo tee /etc/sudoers.d/minicamera >/dev/null
sudo chmod 0440 /etc/sudoers.d/minicamera
sudo visudo -cf /etc/sudoers.d/minicamera >/dev/null
echo "==> NAS mount helper installed for $RUN_USER"
