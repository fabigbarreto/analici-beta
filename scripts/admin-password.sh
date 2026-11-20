#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo 'Uso: bash scripts/admin-password.sh CAMINHO_DO_ARQUIVO' >&2
  exit 1
fi

read -r -s -p 'Senha do administrador do Beta: ' password
printf '\n' >&2
read -r -s -p 'Repita a senha do administrador do Beta: ' confirmation
printf '\n' >&2
if [[ "$password" != "$confirmation" ]]; then
  echo 'As senhas digitadas são diferentes.' >&2
  exit 1
fi

hash=$(printf '%s' "$password" | node "$(dirname -- "$0")/admin-password.mjs")
unset password confirmation
umask 077
set -o noclobber
printf '%s\n' "$hash" > "$1"
