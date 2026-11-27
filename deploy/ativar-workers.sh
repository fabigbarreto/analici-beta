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
etapa='identificar imagem do Mon e conferir o destino de rollback'
mon_image='^(analici-beta:701a001|analici-mon:(701a001|workers-[a-f0-9]{16}))$'
if [[ ! $old =~ $mon_image ]]; then
  echo "Imagem de origem inesperada: $old" >&2
  exit 1
fi
baseid=$(docker inspect --format '{{.Image}}' "$cid")
[[ $(docker image inspect --format '{{.Id}}' "$old") == "$baseid" ]]
etapa='conferir imagem de recuperação configurada no Compose'
configured=$(sed -n 's/^BETA_IMAGE=//p' .env)
[[ $configured =~ $mon_image ]]
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
etapa='identificar bundle da nova página'
bundle=$(sed -nE 's@.*src="(/mon/assets/[^"]+\.js)".*@\1@p' "$ctx/dist/client/index.html")
[[ $bundle =~ ^/mon/assets/[a-zA-Z0-9_-]+\.js$ ]]
grep -Fq 'worker-grid' "$ctx/dist/client${bundle#/mon}"
etapa='construir imagem e guardar configuração anterior'
printf 'FROM %s\nCOPY --chown=node:node dist/ /app/dist/\n' "$old" > "$ctx/Dockerfile"
docker build --pull=false --network=none -t "$tag" "$ctx"
backup=$(mktemp -d "$PWD/releases/workers-XXXXXXXX")
cp -p .env revision "$backup/"
aguardar_saude() {
  local limite=$((SECONDS + 60)) http rc
  while :; do
    rc=0
    http=$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' "$url/api/health") || rc=$?
    if [[ $rc == 0 && $http == 200 ]]; then return 0; fi
    if (( SECONDS >= limite )); then
      printf 'Saúde indisponível após 60 s (curl=%s, HTTP=%s).\n' "$rc" "$http" >&2
      return 1
    fi
    sleep 1
  done
}
rollback() {
  trap - ERR HUP INT TERM
  printf 'Falha na etapa: %s. Iniciando restauração.\n' "$etapa" >&2
  local failed_id
  failed_id=$("${compose[@]}" ps -aq beta) || true
  if [[ -n $failed_id ]]; then
    docker inspect --format 'Estado={{.State.Status}} exit={{.State.ExitCode}} reinícios={{.RestartCount}}' "$failed_id" >&2 || true
    docker logs --tail 60 "$failed_id" >"$backup/ativacao.log" 2>&1 || true
    printf 'Log da ativação na VPS: %s/ativacao.log\n' "$backup" >&2
  fi
  cp -p "$backup/.env" .env
  cp -p "$backup/revision" revision
  "${compose[@]}" up -d --no-deps --no-build --pull never beta
  aguardar_saude || { echo 'Versão anterior selecionada, mas a saúde não foi confirmada.' >&2; exit 1; }
  echo "Configuração anterior restaurada." >&2
  exit 1
}
trap rollback ERR HUP INT TERM
etapa='ativar imagem candidata'
sed -i "s|^BETA_IMAGE=$configured$|BETA_IMAGE=$tag|" .env
"${compose[@]}" up -d --no-deps --no-build --pull never beta
[[ $(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q beta)") == "$(docker image inspect --format '{{.Id}}' "$tag")" ]]
etapa='aguardar HTTP 200 em /mon/api/health'
aguardar_saude
etapa='abrir /mon/workers'
page=$(curl -fsS --max-time 10 "$url/workers")
[[ $page == *"$bundle"* ]]
curl -fsS --max-time 10 "http://127.0.0.1:3107$bundle" -o "$ctx/served-bundle.js"
cmp -s "$ctx/served-bundle.js" "$ctx/dist/client${bundle#/mon}"
etapa='verificar autenticação da API dos Workers'
test "$(curl -sS -o /dev/null -w '%{http_code}' "$url/api/atlas-executions/workers")" = 401
etapa='consultar Workers no Atlas'
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
