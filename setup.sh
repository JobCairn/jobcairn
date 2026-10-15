#!/usr/bin/env bash
# JobCairn one-click setup for macOS. Safe to re-run: it skips anything already installed.
# Usage: ./setup.sh            install everything that is missing
#        ./setup.sh doctor     check only, change nothing
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n==> %s\n' "$1"; }
# Homebrew, quicker: no self-update before each install (the slow, silent part), no hints, no cleanup pass, no analytics.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1

[ "$(uname)" = "Darwin" ] || { echo "JobCairn setup supports macOS for now."; exit 1; }

if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (your Mac asks for your password once)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"

if ! node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)" >/dev/null 2>&1; then
  say "Installing Node.js"
  brew install node
fi

if [ "${1:-}" = "doctor" ]; then
  exec node scripts/setup/run.mjs doctor "${@:2}"
fi

say "Installing JobCairn"
npm ci --no-audit --no-fund
say "Installing tools (skips anything already there)"
node scripts/setup/run.mjs install "$@"
say "All set. Run ./setup.sh doctor any time to check."
