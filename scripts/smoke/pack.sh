#!/usr/bin/env bash
set -euo pipefail

# Smoke pack delegates to the GNOME pack script, which vendors shared/ first.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT_DIR/scripts/gnome/pack.sh"
