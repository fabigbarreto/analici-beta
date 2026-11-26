#!/usr/bin/env bash
set -euo pipefail
etapa='validar argumentos'
trap 'rc=$?; printf "FALHA: %s (linha %s, código %s)\n" "$etapa" "$LINENO" "$rc" >&2' ERR
echo 'Ativador iniciado na VPS.'
[[ $# == 2 && $1 =~ ^/tmp/mon-workers\.[[:alnum:]]{8}$ && $2 =~ ^[a-f0-9]{64}$ ]]
etapa='abrir diretório da implantação'
cd /srv/analici/beta
etapa='obter trava exclusiva da publicação'
exec 9>/run/lock/analici-beta-deploy.lock
flock -n 9
etapa='identificar contêiner beta no Compose'
compose=(docker compose --project-name analici-beta -f compose.yml)
cid=$("${compose[@]}" ps -q beta)
old=$(docker inspect --format '{{.Config.Image}}' "$cid")
printf 'Imagem ativa: %s\n' "$old"
tag=analici-mon:workers-${2:0:16}
if [[ $old == "$tag" ]]; then
  echo "Esta imagem já está ativa."
  exit 0
fi
etapa='comparar imagem ativa com analici-mon:701a001'
[[ $old == analici-mon:701a001 ]]
etapa='conferir BETA_IMAGE no arquivo .env'
grep -Fxq "BETA_IMAGE=$old" .env
etapa='comparar revisão registrada com mon-701a001'
revision=$(cat revision)
printf 'Revisão registrada: %q\n' "$revision"
[[ $revision == mon-701a001 ]]
etapa='preparar imagem e cópia de recuperação'
umask 077
ctx=$(mktemp -d)
trap 'rm -rf -- "$ctx"' EXIT
cp "$1/workers.tgz" "$ctx/package.tgz"
(cd "$ctx" && printf '%s  package.tgz\n' "$2" | sha256sum -c - && tar -xzf package.tgz && rm package.tgz)
baseid=$(docker inspect --format '{{.Image}}' "$cid")
[[ $(docker image inspect --format '{{.Id}}' "$old") == "$baseid" ]]
printf 'FROM %s\nCOPY --chown=node:node dist/ /app/dist/\n' "$old" > "$ctx/Dockerfile"
docker build --pull=false --network=none -t "$tag" "$ctx"
backup=$(mktemp -d "$PWD/releases/workers-XXXXXXXX")
cp -p .env revision "$backup/"
rollback() {
  printf 'Falha na ativação. Iniciando restauração.\n' >&2
  trap - ERR HUP INT TERM
  cp -p "$backup/.env" .env
  cp -p "$backup/revision" revision
  "${compose[@]}" up -d --no-deps --no-build --pull never beta
  echo "Configuração anterior restaurada." >&2
  exit 1
}
trap rollback ERR HUP INT TERM
sed -i "s|^BETA_IMAGE=$old$|BETA_IMAGE=$tag|" .env
"${compose[@]}" up -d --no-deps --no-build --pull never beta
url=http://127.0.0.1:3107/mon
curl -fsS --retry 12 --retry-connrefused --retry-delay 1 "$url/api/health" >/dev/null
curl -fsS "$url/workers" | grep -F '/mon/assets/' >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' "$url/api/atlas-executions/workers")" = 401
"${compose[@]}" exec -T beta node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {makeExecutionsReader} from './dist/atlas-executions.mjs';
const pool = new Pool({connectionString:readFileSync(process.env.ATLAS_EXECUTIONS_DATABASE_URL_FILE,'utf8').trim(),connectionTimeoutMillis:4000,statement_timeout:8000});
try {
  const result=await makeExecutionsReader(pool).workerHealth();
  if (!result.workers.length) throw Error('Nenhum Worker retornado');
  console.log('Workers consultados:',result.workers.length);
} finally { await pool.end(); }
JS
printf '%s\n' "${tag#*:}" > revision
trap - ERR HUP INT TERM
echo "Publicado $tag em /mon/workers. Backup: $backup"
