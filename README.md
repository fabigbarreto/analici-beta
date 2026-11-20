# ANALICI Beta

A primeira tela do Beta acompanha a disponibilidade, a última coleta, a CPU,
a memória e o uso do disco principal (`/`) das VPSs. Selecione um cartão
para filtrar os gráficos. Use **Armazenamento** no menu lateral para abrir
a página de disco em `/armazenamento`. O histórico oferece períodos de 1, 6 e 24 horas e atualiza a cada
minuto. Lacunas indicam intervalos sem amostras. Os horários usam Brasília.

## Prévia

Com Node.js 22 ou superior, execute:

```bash
npm ci
npm run demo
```

A demonstração abre localmente com dados fictícios identificados na tela.
O modo de demonstração existe apenas no servidor de desenvolvimento do Vite.

## Login local e dados reais

Copie `.env.example` para `.env`. Defina `BETA_ADMIN_USERNAME` e execute
o comando abaixo no terminal para criar a senha do administrador. O terminal
oculta os caracteres e o script grava o hash da senha em um arquivo privado.

```bash
mkdir -m 700 -p .secrets
bash scripts/admin-password.sh .secrets/admin-password
```

Informe o caminho em `BETA_ADMIN_PASSWORD_HASH_FILE`. A sessão dura oito horas e
termina ao sair da conta ou reiniciar o processo. Para trocar a senha, gere o
hash em um arquivo novo, substitua o arquivo usado pelo serviço e reinicie o Beta.

Coloque a URL PostgreSQL da credencial de leitura em um arquivo privado e aponte
`MONITORING_DATABASE_URL_FILE` para ele. Conceda acesso ao schema `telemetry`
e permissão de leitura nas tabelas `telemetry.metric_batches`,
`telemetry.host_metrics` e `telemetry.disk_metrics`. Os identificadores em `MONITORING_NODES` devem
corresponder ao campo `node_id` dos registros persistidos.

```bash
npm run dev
npm run build
npm start
```

## Implantação na própria VPS

Construa a imagem com `docker build -t analici-beta:local .`. Em
`deploy/.env`, defina `BETA_IMAGE=analici-beta:local`,
`BETA_DATABASE_NETWORK` com o nome da rede privada do PostgreSQL,
`BETA_PUBLIC_ORIGIN` com a URL HTTPS exata, `BETA_ADMIN_USERNAME` e
`MONITORING_NODES`. Os arquivos `deploy/secrets/admin-password` e
`deploy/secrets/database-url` ficam fora do Git. Permita leitura ao usuário 1000
do contêiner, por exemplo com arquivos `root:1000` no modo `0440` e diretório
`root:1000` no modo `0750`.

Inicie o contêiner com `docker compose -f deploy/compose.yml up -d`. Ele atende
na porta 3107 do próprio host. Use `deploy/Caddyfile.example` como exemplo para
o proxy HTTPS local, com o domínio apontando para a VPS. O PostgreSQL atende pela
rede privada do Docker.

## Testes

`npm test` verifica autenticação, expiração e encerramento da sessão, limitação de
tentativas e proteção da API de monitoramento. Para executar também a consulta
real, defina `BETA_TEST_DATABASE_URL` com um PostgreSQL **local, vazio e
descartável** chamado `monitoring_test`. O teste cria as tabelas fictícias
para verificar dados persistidos, médias, lacunas e estados dos nós.
