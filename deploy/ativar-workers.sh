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
etapa='identificar imagem da versão 701a001 e conferir o destino de rollback'
case "$old" in
  analici-mon:701a001|analici-beta:701a001) ;;
  *) echo "Imagem de origem inesperada: $old" >&2; exit 1 ;;
esac
baseid=$(docker inspect --format '{{.Image}}' "$cid")
[[ $(docker image inspect --format '{{.Id}}' "$old") == "$baseid" ]]
etapa='conferir imagem de recuperação configurada no Compose'
configured=$(sed -n 's/^BETA_IMAGE=//p' .env)
[[ $configured == analici-beta:701a001 || $configured == analici-mon:701a001 ]]
[[ $(docker image inspect --format '{{.Id}}' "$configured") == "$baseid" ]]
[[ $("${compose[@]}" config --images beta) == "$configured" ]]
etapa='confirmar o serviço Mon na porta 3107'
url=http://127.0.0.1:3107/mon
docker port "$cid" 3000/tcp | grep -Fx '127.0.0.1:3107' >/dev/null
curl -fsS "$url/api/health" >/dev/null
curl -fsS "$url/execucoes" | grep -F '/mon/assets/' >/dev/null
etapa='ler revisão para o backup'
revision=$(cat revision)
printf 'Revisão registrada: %q\n' "$revision"
etapa='preparar imagem e cópia de recuperação'
umask 077
ctx=$(mktemp -d)
trap 'rm -rf -- "$ctx"' EXIT
cp "$1/workers.tgz" "$ctx/package.tgz"
(cd "$ctx" && printf '%s  package.tgz\n' "$2" | sha256sum -c - && tar -xzf package.tgz && rm package.tgz)
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
sed -i "s|^BETA_IMAGE=$configured$|BETA_IMAGE=$tag|" .env
"${compose[@]}" up -d --no-deps --no-build --pull never beta
[[ $(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q beta)") == "$(docker image inspect --format '{{.Id}}' "$tag")" ]]
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
