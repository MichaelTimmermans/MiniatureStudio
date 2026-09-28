#!/usr/bin/env bash
# MiniCamera installer for Raspberry Pi OS (Bookworm or newer).
#
#   curl -fsSL <raw url of this file> | bash
# or, from a clone:
#   ./install.sh
#
# Installs apt dependencies, clones the app (with the focus-stack submodule)
# into /opt/minicamera, builds focus-stack, and sets up a systemd service.
# Safe to run again: an existing install is updated instead.
set -euo pipefail

REPO_URL="${MINICAMERA_REPO:-https://git.timmermansmichael.be/Michael/MiniCamera.git}"
BRANCH="${MINICAMERA_BRANCH:-main}"
INSTALL_DIR="${MINICAMERA_DIR:-/opt/minicamera}"
SERVICE=minicamera
RUN_USER="${SUDO_USER:-$USER}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ] && die "run as your normal user (the script uses sudo where needed)"
command -v apt-get >/dev/null || die "this installer needs Debian / Raspberry Pi OS (apt)"

# Running from inside a clone? Then install in place.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [ -f "$SCRIPT_DIR/app.py" ] && [ -d "$SCRIPT_DIR/.git" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
fi

say "Installing system packages"
sudo apt-get update
if [ -f "$INSTALL_DIR/apt-packages.txt" ]; then
  PKGS=$(grep -Ev '^\s*(#|$)' "$INSTALL_DIR/apt-packages.txt")
else
  # First run via curl: git is needed before the package list is available.
  PKGS="git"
fi
# shellcheck disable=SC2086
sudo apt-get install -y $PKGS

if [ ! -d "$INSTALL_DIR/.git" ]; then
  say "Cloning $REPO_URL into $INSTALL_DIR"
  sudo mkdir -p "$INSTALL_DIR"
  sudo chown "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
  git clone --branch "$BRANCH" --recurse-submodules "$REPO_URL" "$INSTALL_DIR"
  # shellcheck disable=SC2046
  sudo apt-get install -y $(grep -Ev '^\s*(#|$)' "$INSTALL_DIR/apt-packages.txt")
else
  say "Existing install found in $INSTALL_DIR — updating"
  git -C "$INSTALL_DIR" pull --ff-only || say "git pull failed (local changes?) — continuing with current version"
  git -C "$INSTALL_DIR" submodule update --init --recursive
fi

"$INSTALL_DIR/scripts/build-focus-stack.sh"

say "Installing systemd service '$SERVICE'"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=MiniCamera miniature photo booth
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/python3 $INSTALL_DIR/app.py
Restart=always
RestartSec=2
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
if ! groups "$RUN_USER" | grep -qw video; then
  sudo usermod -aG video "$RUN_USER"
  say "Added $RUN_USER to the 'video' group (camera access)"
fi
sudo ln -sf "$INSTALL_DIR/update.sh" /usr/local/bin/minicamera-update
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE
sudo systemctl restart $SERVICE


PORT=$(python3 -c "import json;print(json.load(open('$INSTALL_DIR/config.example.json'))['server']['port'])")
say "Done! Open http://$(hostname).local:$PORT in your browser"
say "Update later with: minicamera-update (or the Update button in Instellingen)"
if ! rclone listremotes 2>/dev/null | grep -q .; then
  say "Optional Google Drive: run 'rclone config' and create a remote called 'gdrive'"
fi
