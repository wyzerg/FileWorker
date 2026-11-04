#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM="darwin-arm64" ;;
    Darwin-x86_64) PLATFORM="darwin-x64" ;;
    Linux-x86_64) PLATFORM="linux-x64" ;;
    Linux-aarch64) PLATFORM="linux-arm64" ;;
    *) printf 'Node.js is required on this platform.\n' >&2; exit 1 ;;
  esac
  NODE_HOME="${FILEWORKER_NODE_HOME:-$HOME/.local/share/nodejs/node-v$VERSION-$PLATFORM}"
  if [[ ! -x "$NODE_HOME/bin/node" ]]; then
    printf 'Node.js not found. Expected: %s/bin/node\n' "$NODE_HOME" >&2
    exit 1
  fi
  export PATH="$NODE_HOME/bin:$PATH"
fi

cd "$ROOT"
if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required. Install the version in package.json using npm.\n' >&2
  exit 1
fi
exec pnpm "$@"
