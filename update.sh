#!/usr/bin/env bash
# Update MiniCamera to the latest version.
#   minicamera-update               # pull, rebuild what changed, restart the service
#   minicamera-update --check       # only report whether an update is available
#   minicamera-update --no-restart  # used by the Update button in the web UI
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$DIR"
MODE="${1:-}"

git fetch --quiet --tags origin
BEHIND=$(git rev-list --count HEAD..@{u})
if [ "$MODE" = "--check" ]; then
  echo "$BEHIND commit(s) behind"
  git log --oneline HEAD..@{u}
  exit 0
fi
if [ "$BEHIND" -eq 0 ] && [ -x vendor/focus-stack/build/focus-stack ]; then
  echo "Already up to date ($(git describe --tags --always))"
  exit 0
fi

OLD=$(git rev-parse HEAD)
echo "==> Updating $(git describe --tags --always) -> latest"
git pull --ff-only
git submodule sync --quiet
git submodule update --init --recursive

if ! git diff --quiet "$OLD" HEAD -- apt-packages.txt; then
  PKGS=$(grep -Ev '^\s*(#|$)' apt-packages.txt)
  if sudo -n true 2>/dev/null; then
    echo "==> Installing new system packages"
    # shellcheck disable=SC2086
    sudo apt-get install -y $PKGS
  else
    echo "WARNING: apt-packages.txt changed — run 'minicamera-update' from a terminal (needs sudo)"
  fi
fi

if ! git diff --quiet "$OLD" HEAD -- scripts/minicamera-mount scripts/install-mount-helper.sh; then
  if sudo -n true 2>/dev/null; then
    scripts/install-mount-helper.sh
  else
    echo "WARNING: the NAS mount helper changed — run 'minicamera-update' from a terminal (needs sudo)"
  fi
fi

if ! git diff --quiet "$OLD" HEAD -- vendor/focus-stack || [ ! -x vendor/focus-stack/build/focus-stack ]; then
  scripts/build-focus-stack.sh
fi

echo "==> Now at $(git describe --tags --always)"
if [ "$MODE" != "--no-restart" ] && systemctl is-enabled --quiet minicamera 2>/dev/null; then
  sudo systemctl restart minicamera
  echo "==> Service restarted"
fi
