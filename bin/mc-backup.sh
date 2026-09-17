#!/usr/bin/env bash
# Backs up the plain-files Phase 1 store (mission history, audit log, tool policy) plus the
# raw Gateway event log. There's no database to dump -- data/ and logs/ already are the data,
# so backup/restore is just tar. Run with the server stopped, or accept a backup that might
# catch a file mid-write (JSONL appends are the only risk, and are append-only so a partial
# last line is the worst case).
set -euo pipefail
cd "$(dirname "$0")/.."
ts=$(date +%Y%m%d-%H%M%S)
out="mission-control-backup-$ts.tar.gz"
targets=()
[ -d data ] && targets+=(data/)
[ -d logs ] && targets+=(logs/)
if [ ${#targets[@]} -eq 0 ]; then
  echo "nothing to back up yet -- data/ doesn't exist until the server has run at least once" >&2
  exit 1
fi
tar czf "$out" "${targets[@]}"
echo "wrote $out"
echo "restore with: tar xzf $out   (run from the project root, ideally with the server stopped)"
