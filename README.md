# ANALICI Beta

A primeira tela do Beta acompanha a disponibilidade, a última coleta, a CPU
e a memória das VPSs de uma instalação. Selecione um cartão para filtrar os
gráficos. O histórico oferece períodos de 1, 6 e 24 horas e atualiza a cada
minuto. Lacunas indicam intervalos sem amostras. Os horários usam Brasília.

## Prévia

Com Node.js 22 ou superior:

```bash
npm ci
npm run demo
```

A demonstração abre localmente com dados fictícios identificados na tela.
O modo de demonstração existe apenas no servidor de desenvolvimento do Vite.

## Dados reais

Crie um `.env` local a partir de `.env.example`. Configure o login Google no
projeto Firebase escolhido para o Beta e habilite o domínio da aplicação.
Preencha as variáveis `VITE_FIREBASE_*` com a configuração web do mesmo projeto
informado em `FIREBASE_PROJECT_ID`. O servidor aceita somente contas com
e-mail verificado e incluídas em `MONITORING_ADMIN_EMAILS`, separado por vírgulas.

Use uma credencial de leitura em `MONITORING_DATABASE_URL`, com acesso ao
schema `telemetry` e às tabelas `telemetry.metric_batches` e
`telemetry.host_metrics`. O servidor consulta o PostgreSQL em transações
somente de leitura. Os identificadores em `MONITORING_NODES` devem corresponder
ao campo `node_id` dos registros persistidos. A URL do banco e a lista de
contas autorizadas são variáveis exclusivas do servidor.

```bash
npm run dev
npm run build
npm start
```

Para implantação, defina `HOST` e `PORT` conforme o destino e coloque a
aplicação atrás do proxy HTTPS homologado. O ambiente de produção deve carregar
os valores privados pelo seu mecanismo de segredos.

## Testes

`npm test` verifica autenticação, autorização, validação de parâmetros e
respostas de erro. Para executar também a consulta real, defina
`BETA_TEST_DATABASE_URL` com um PostgreSQL **local, vazio e descartável** chamado
`monitoring_test`. O teste cria as tabelas fictícias para verificar dados
persistidos, médias, lacunas e estados dos nós.
