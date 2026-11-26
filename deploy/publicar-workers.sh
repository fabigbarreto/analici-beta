#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cd "$repo"
tar -czf "$tmp/workers.tgz" dist/client dist/server.mjs dist/atlas-executions.mjs
hash=$(sha256sum "$tmp/workers.tgz" | cut -d' ' -f1)
remote=$(ssh -o StrictHostKeyChecking=yes analici-app 'mktemp -d /tmp/mon-workers.XXXXXXXX')
[[ $remote =~ ^/tmp/mon-workers\.[[:alnum:]]{8}$ ]]
scp -o StrictHostKeyChecking=yes "$tmp/workers.tgz" "$repo/deploy/ativar-workers.sh" "analici-app:$remote/"
ssh -tt -o StrictHostKeyChecking=yes analici-app "sudo bash '$remote/ativar-workers.sh' '$remote' '$hash'" || {
  rc=$?
  printf 'Publicação interrompida. Código retornado por SSH/sudo: %s\n' "$rc" >&2
  exit "$rc"
}
