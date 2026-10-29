# ARCHITECTURE.md — Distributed Wagering Processor

> **Status:** arquitetura-alvo com entregas até o Stage 2; lacunas identificadas na revalidação de 2026-10-29 corrigidas e testadas.
> **Objetivo:** documentar as decisões, invariantes e trade-offs da implementação.  
> **Escopo:** este documento descreve o desenho pretendido; decisões ainda não implementadas devem ser tratadas como plano, não como garantias já comprovadas.

### Estado implementado e limites da validação

- **Stage 0:** Bun/NestJS, configuração, liveness, PostgreSQL/LocalStack e três filas FIFO disponíveis. A seleção visual dos agentes no VS Code continua sem confirmação.
- **Stage 1:** domínio puro, dinheiro exato em `bigint`, factories/rehydration, estados, operações, referências e reversões. `ProcessWager` é um serviço puro, não o caso de uso transacional futuro.
- **Stage 2:** cinco tabelas, mappings MikroORM, migrations explícitas, abertura atômica de wallet, consultas, ledger append-only, cursor e reconciliação sem reparo. O teste de rollback nas cinco tabelas valida a infraestrutura, não um pipeline de apostas/SQS implementado.
- **Stages 3–5:** processamento transacional de apostas, hash/replay, locks/retries, API de apostas, workers, recuperação, readiness, métricas exportadas e verificação multi-processo continuam planejados.

A revalidação inicial passou em 92 testes, mas sondagens adicionais confirmaram duas lacunas. Ambas foram corrigidas; a suíte atual passa em 103 testes / 309 assertions (31 testes de integração PostgreSQL), lint, type-check, build e formatação:

1. A nova migration `RejectNonFiniteMoney` rejeita `NaN` e infinitos explicitamente nas cinco colunas monetárias de wallet, transação e ledger. A migration inicial permanece intacta. Dados legados inválidos causam falha explícita na aplicação da migration, sem reparo silencioso. O `down` da correção remove apenas suas constraints e preserva os dados.
2. O filtro existente de erros HTTP está registrado globalmente via `APP_FILTER`, não apenas no controller. JSON malformado retorna `400` com `{ code: "INVALID_REQUEST", message: "Invalid request." }`, sem expor o corpo recebido. Testes reais cobrem essa borda.

As duas lacunas da auditoria estão encerradas. O Stage 3 ainda não foi iniciado. As seções seguintes mantêm os requisitos-alvo; não representam garantia de funcionalidades futuras ou validação visual dos agentes.

## 1. Contexto e objetivos

O sistema recebe operações de apostas de múltiplos provedores e atualiza wallets de jogadores. As operações podem chegar por HTTP ou por SQS e podem ser duplicadas, entregues fora de ordem, processadas concorrentemente ou reentregues após falhas.

O objetivo principal é preservar a correção financeira e a auditabilidade, mesmo com múltiplas instâncias da aplicação e indisponibilidades temporárias de PostgreSQL ou SQS.

### 1.1 Invariantes

A implementação deve preservar estas invariantes:

1. Uma operação financeira não pode gerar débito ou crédito duplicado.
2. O saldo de uma wallet nunca pode ser negativo.
3. O saldo materializado deve corresponder ao saldo reconstruído a partir do ledger.
4. Cada alteração de saldo deve ter um lançamento correspondente no ledger.
5. Os lançamentos do ledger são imutáveis e auditáveis.
6. Uma chave de idempotência reutilizada com payload diferente é conflito, não replay.
7. O estado financeiro, o ledger, a inbox aplicável e a outbox devem ser persistidos atomicamente.
8. Eventos só podem ser publicados depois do commit financeiro.
9. As garantias devem continuar válidas com três ou mais instâncias da aplicação.
10. Recursos de deduplicação ou ordenação do broker são complementares; a garantia final de consistência está no banco de dados e no protocolo transacional.

### 1.2 Fora do escopo inicial

Para manter o foco no desafio, a implementação inicial não pretende incluir:

- microserviços independentes por domínio;
- Kubernetes ou infraestrutura de produção em nuvem;
- ledger de partidas dobradas;
- múltiplas moedas efetivamente utilizadas nos cenários operacionais — o desafio pode operar em BRL, mas o modelo continuará preparado para validar moedas;
- dashboard de observabilidade completo;
- autenticação artesanal ou gestão própria de senhas.

## 2. Arquitetura de alto nível

A solução será um **monólito modular**, organizado com princípios de Clean Architecture e DDD. A API e os workers serão processos executáveis separados a partir da mesma base de código e compartilharão os mesmos casos de uso.

```text
                  ┌─────────────────────┐
                  │   Game Providers    │
                  └──────────┬──────────┘
                             │ HTTP
                             ▼
                  ┌─────────────────────┐
                  │     NestJS API      │
                  │ DTO / Validation    │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Application Layer   │
                  │ ProcessWagerUseCase │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Domain + Ports      │
                  │ Money / Wallet /    │
                  │ WagerTransaction    │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ PostgreSQL          │
                  │ Wallet / Transaction│
                  │ Ledger / Inbox      │
                  │ Outbox               │
                  └──────────┬──────────┘
                             │
                ┌────────────┴─────────────┐
                │                          │
                ▼                          ▼
       ┌──────────────────┐       ┌──────────────────┐
       │ SQS Consumer     │       │ Outbox Publisher  │
       │ + Retry / DLQ    │       │ + Retry / Backoff │
       └────────┬─────────┘       └────────┬─────────┘
                │                          │
                └────────────┬─────────────┘
                             ▼
                  ┌─────────────────────┐
                  │ AWS SQS / LocalStack│
                  └─────────────────────┘
```

O diagrama representa responsabilidades lógicas. A API, o consumidor SQS, o publisher da outbox e o reprocessador de referências podem ser iniciados como processos diferentes, mas reutilizam os módulos e casos de uso do mesmo projeto.

### 2.1 Por que monólito modular

- O domínio financeiro fica coeso e as regras são implementadas uma única vez.
- A solução evita a complexidade de rede e consistência entre serviços que não é necessária para o escopo.
- Os processos podem escalar horizontalmente sem mudar o modelo de implantação.
- As fronteiras entre domínio, aplicação e infraestrutura permitem testar regras sem depender de NestJS, PostgreSQL ou SQS.

## 3. Stack tecnológica

| Responsabilidade          | Escolha                                        | Motivo                                                                                                                            |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Runtime / package manager | Bun 1.x                                        | Requisito do desafio.                                                                                                             |
| Linguagem                 | TypeScript em modo strict                      | Tipagem explícita e contratos claros.                                                                                             |
| Framework HTTP            | NestJS                                         | Requisito do desafio e suporte a módulos/DI.                                                                                      |
| Banco de dados            | PostgreSQL                                     | Fonte de verdade transacional.                                                                                                    |
| ORM                       | MikroORM                                       | Opção preferencial do desafio; Unit of Work e suporte a transações/locking.                                                       |
| Mensageria                | AWS SQS                                        | Requisito do desafio.                                                                                                             |
| SQS local                 | LocalStack                                     | Integração local por Docker Compose.                                                                                              |
| Migrations                | MikroORM Migrations                            | Schema versionado e reproduzível.                                                                                                 |
| Precisão monetária        | `bigint` em unidades menores dentro de `Money` | Aritmética exata para valores de qualquer magnitude sem usar `number` para dinheiro ou depender de precisão decimal configurável. |
| Validação HTTP            | Zod                                            | Schemas estritos já usados em configuração e contratos de wallet; evita uma segunda stack de validação.                           |
| Testes                    | `bun test`                                     | Runner compatível com o runtime escolhido.                                                                                        |
| Logs                      | Pino ou logger JSON equivalente                | Logs estruturados.                                                                                                                |
| Métricas                  | `prom-client`                                  | Exposição de métricas operacionais.                                                                                               |
| Autenticação              | Keycloak/OIDC, opcional                        | Usar Identity Provider externo se implementada.                                                                                   |
| Ambiente local            | Docker Compose                                 | Subir API, workers, PostgreSQL e LocalStack.                                                                                      |

### 3.1 Restrições tecnológicas

- Não usar `number`, `float` ou `double` para representar dinheiro.
- Não usar Prisma ou outro ORM fora das opções permitidas no desafio.
- Não depender de cache em memória para idempotência.
- Não usar SQS FIFO como única garantia de consistência.
- Não publicar eventos antes do commit financeiro.
- Não alterar ou excluir lançamentos do ledger.
- Não usar lock global compartilhado entre todas as wallets.

A configuração TypeScript usa `module: Node16` e `moduleResolution: Node16`, substituindo o alias legado `Node`/`node10`. Sem `"type": "module"` no pacote, os arquivos atuais continuam emitidos como CommonJS; isso não migra o runtime Bun para Node.js.

## 4. Organização do código

A estrutura exata pode evoluir conforme a implementação. A proposta inicial é organizar por módulos de domínio e separar domínio, aplicação, infraestrutura e apresentação.

```text
src/
├── main.ts
├── app.module.ts
├── modules/
│   ├── wallets/
│   │   ├── domain/
│   │   │   ├── entities/wallet.ts
│   │   │   ├── value-objects/money.ts
│   │   │   ├── errors/
│   │   │   └── services/
│   │   ├── application/
│   │   │   ├── use-cases/
│   │   │   └── ports/
│   │   ├── infrastructure/
│   │   │   └── persistence/
│   │   └── presentation/http/
│   ├── wagering/
│   │   ├── domain/
│   │   │   ├── entities/wager-transaction.ts
│   │   │   ├── enums/
│   │   │   └── policies/
│   │   ├── application/
│   │   │   ├── use-cases/process-wager.use-case.ts
│   │   │   └── ports/
│   │   ├── infrastructure/
│   │   └── presentation/http/
│   ├── ledger/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── reliability/
│   │   ├── idempotency/
│   │   ├── inbox/
│   │   ├── outbox/
│   │   └── pending-references/
│   ├── messaging/
│   │   ├── contracts/
│   │   └── infrastructure/sqs/
│   └── observability/
│       ├── logging/
│       ├── metrics/
│       └── health/
└── database/
    └── migrations/

test/
├── unit/
├── integration/
├── concurrency/
└── fixtures/
```

### 4.1 Regras de dependência

- `domain` não importa NestJS, MikroORM, AWS SDK ou componentes de infraestrutura.
- `application` coordena casos de uso e depende de contratos/ports, não de implementações concretas.
- `infrastructure` implementa ports e contém integrações técnicas.
- `presentation` valida contratos externos, invoca casos de uso e converte resultados em respostas HTTP.
- O consumidor SQS invoca o mesmo caso de uso de processamento utilizado pela API.
- Objetos de domínio são criados por factories (`create`, `open`, `from`) e reconstruídos por `rehydrate`, conforme o contrato do desafio.

## 5. Modelo de domínio

### 5.1 `Money` — Value Object

`Money` é imutável e encapsula unidades menores inteiras (`bigint`) e moeda.

Responsabilidades:

- receber e serializar `amount` como string decimal com duas casas, convertendo para unidades menores inteiras sem passar por `number`;
- rejeitar entradas vazias, `NaN`, `Infinity`, notação científica e escala superior a duas casas;
- impedir operações entre moedas diferentes;
- disponibilizar operações de soma, subtração, negação, comparação e igualdade;
- não depender de decorators ou tipos monetários do ORM.

O valor monetário não deve ser convertido para `number` em nenhuma etapa do domínio. A escolha de `bigint` em unidades menores evita limites de precisão aritmética configurável. A persistência usa `NUMERIC(38,2)`, com limite de 36 dígitos inteiros e duas casas decimais: `999999999999999999999999999999999999.99`. O domínio continua exato para valores maiores, mas a API e o mapping rejeitam valores fora desse limite ou com escala excedente, sem arredondar ou converter para `number`. Essa validação de escala não se aplica a SQL arbitrário: o cast nativo de PostgreSQL arredonda escala excedente (`1.005` vira `1.01`). As constraints adicionais bloqueiam valores não finitos inclusive via SQL direto.

### 5.2 `Wallet` — Aggregate Root

A wallet encapsula saldo e versão.

Invariantes:

- existe no máximo uma wallet por `playerId + currency`;
- saldo não pode ser negativo;
- moeda da operação deve corresponder à moeda da wallet;
- `version` começa em `1` e incrementa somente quando o saldo muda;
- qualquer mudança de saldo deve ter lançamento correspondente no ledger.

### 5.3 `WagerTransaction`

Representa uma operação externa ou a transação interna `OPENING`.

Tipos previstos:

- `OPENING`
- `BET`
- `WIN`
- `LOSS`
- `REFUND`
- `ROLLBACK`

Estados previstos:

- `PENDING`
- `PENDING_REFERENCE`
- `PROCESSED`
- `REJECTED`
- `FAILED`

`PROCESSED`, `REJECTED` e `FAILED` são estados terminais. Tentativas de transição a partir deles devem ser tratadas como erro de programação. `OPENING` é interno e não pode ser submetido pela API ou pela fila.

A factory interna de `OPENING` exige identificadores não vazios e valor positivo; abertura de saldo zero não cria transação. Referências fornecidas, inclusive as opcionais de `WIN`, não podem ser vazias. Apenas `REJECTED` e `FAILED` carregam código de falha; os demais estados não aceitam `failureCode`.

A identidade externa da operação deve considerar o provedor e o identificador externo. A chave de idempotência é obrigatória no contrato HTTP; uma chave reutilizada com payload diferente deve gerar conflito.

### 5.4 `WalletLedgerEntry`

Representa um lançamento financeiro imutável.

Cada entrada registra, no mínimo:

- wallet;
- transação associada;
- direção (`DEBIT` ou `CREDIT`);
- valor e moeda;
- saldo anterior;
- saldo posterior;
- instante de criação.

A factory valida a equação do lançamento. No modelo inicial, uma transação produz no máximo um lançamento por wallet. `LOSS` e operações rejeitadas não geram lançamento.

### 5.5 Inbox e Outbox

- **Inbox:** persiste o recebimento de mensagens e permite deduplicar a mesma mensagem por `(consumerName, messageId)`.
- **Outbox:** persiste eventos de integração na mesma transação SQL das alterações financeiras e permite publicá-los posteriormente com retry.

Os registros de ledger não são sobrescritos nem excluídos. Estados de transação, inbox e outbox seguem as transições e regras de retenção definidas pela implementação.

## 6. Modelo de persistência e integridade

O PostgreSQL é a fonte de verdade do saldo, das transações, do ledger e dos registros de confiabilidade.

### 6.1 Tabelas principais

| Tabela                  | Finalidade                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `wallets`               | Saldo materializado, moeda, versão e timestamps.                                                 |
| `wager_transactions`    | Operações, identidade externa, chave/hash de idempotência, estado, referência e código de falha. |
| `wallet_ledger_entries` | Histórico imutável de movimentos de saldo.                                                       |
| `inbox_messages`        | Deduplicação persistente de mensagens recebidas.                                                 |
| `outbox_messages`       | Eventos pendentes ou publicados e metadados de retry.                                            |

Nomes e colunas finais podem ser adaptados, desde que as garantias sejam mantidas.

### 6.2 Constraints e índices

O schema deve aplicar as invariantes relevantes, não apenas o código da aplicação.

- `UNIQUE (player_id, currency)` em `wallets`.
- `CHECK (balance >= 0)` em `wallets`.
- Unicidade da chave de idempotência no escopo definido pelo contrato.
- Unicidade de `(provider_id, external_transaction_id)` para a identidade externa adotada.
- `UNIQUE (transaction_id)` em `wallet_ledger_entries`, conforme o modelo de no máximo um lançamento por transação.
- `UNIQUE (consumer_name, message_id)` em `inbox_messages`.
- Chave primária única para cada registro da outbox.
- Índices para busca de referências por `(provider_id, external_transaction_id)`.
- Índices para localizar transações `PENDING_REFERENCE` elegíveis para reprocessamento.
- Índices para selecionar eventos pendentes e vencidos da outbox.

As constraints exatas devem refletir a semântica do domínio e o tratamento de `OPENING`. A migration e os testes de integração devem verificar que as garantias existem no banco.

> Uma constraint `CHECK` de saldo não prova, isoladamente, que o saldo coincide com o ledger. Essa relação é mantida pelo protocolo transacional e verificada pela reconciliação.

### 6.3 Migrations

- Migrations são versionadas e executadas em ambiente local e CI.
- Cada mudança de schema deve ser revisável.
- Reversões devem ser implementadas quando forem seguras e viáveis; mudanças destrutivas de dados podem exigir procedimento operacional específico.
- Testes de integração devem iniciar com banco limpo e validar as migrations.

A migration inicial só pode ser revertida quando todas as cinco tabelas estiverem vazias. O `down` bloqueia as tabelas antes de verificar e recusa a operação se houver dados; não existe rollback destrutivo automático de dados financeiros. As migrations são executadas explicitamente, nunca por atualização automática do schema no startup da API.

## 7. Concorrência e transações financeiras

### 7.1 Estratégia inicial: pessimistic locking por wallet

A unidade de concorrência é `walletId`. A estratégia inicial é bloquear a linha da wallet com `SELECT ... FOR UPDATE` dentro da transação PostgreSQL.

Fluxo conceitual de uma operação:

1. Validar o contrato externo e normalizar os campos de negócio.
2. Calcular o hash canônico do payload.
3. Iniciar a transação SQL.
4. Resolver a identidade/idempotência de forma segura para chamadas concorrentes.
5. Bloquear a wallet relevante.
6. Recarregar e validar o estado persistido da operação e suas referências.
7. Aplicar as regras de domínio.
8. Persistir o estado da transação.
9. Se houver mudança de saldo, atualizar a wallet e inserir o lançamento do ledger.
10. Persistir os eventos de integração na outbox.
11. Confirmar o commit.
12. Só depois do commit, responder à chamada HTTP ou confirmar a mensagem SQS.

A ordem de aquisição dos locks deve ser consistente para reduzir deadlocks. Quando houver mais de um recurso bloqueado, a implementação deve definir uma ordem estável e tratar deadlocks/transient failures com retry limitado e seguro.

### 7.2 Por que pessimistic locking

A operação depende do saldo corrente e a wallet é a unidade de concorrência definida pelo desafio. O bloqueio por linha torna explícito que operações da mesma wallet são serializadas, enquanto wallets diferentes podem ser processadas em paralelo.

O campo `version` continua sendo mantido e incrementado apenas quando o saldo muda. Optimistic locking é uma alternativa válida, mas não será a estratégia inicial, salvo se medições ou testes demonstrarem que ela é mais adequada.

### 7.3 Restrições da estratégia

- Não usar lock global para todas as wallets.
- Não confiar apenas em `read → calculate → update` sem controle de concorrência.
- Não tratar um lock em memória como garantia entre instâncias.
- Não assumir que SQS FIFO resolve a consistência financeira.
- Tratar violações de unicidade como resultados concorrentes esperados quando aplicável, sem mascarar erros inesperados.

## 8. Idempotência

A idempotência precisa sobreviver a reinícios e ser segura sob requisições concorrentes.

### 8.1 Chave e hash

O header `Idempotency-Key` é obrigatório na submissão HTTP. O valor recomendado é:

`{providerId}:{externalTransactionId}`

O `payloadHash` será calculado a partir de JSON canônico dos campos de negócio, com ordenação determinística das chaves. O header e os metadados de transporte não entram no hash. O algoritmo e os campos incluídos devem ser documentados e testados.

### 8.2 Comportamento esperado

- Chave inexistente: registrar a identidade e processar a operação.
- Chave existente com hash igual: retornar o resultado original, indicando replay.
- Chave existente com hash diferente: retornar conflito sem novo efeito financeiro.
- Duas requisições concorrentes com a mesma chave: a unicidade no banco arbitra a disputa; a requisição perdedora recupera o resultado original ou retorna conflito após comparar o hash.

A resposta de replay deve preservar o resultado original, incluindo o saldo observado naquele processamento, e não substituir esse saldo pelo saldo atual da wallet.

### 8.3 Idempotência não é Inbox

- A **idempotency key** identifica a operação financeira.
- A **Inbox** identifica a entrega de uma mensagem a um consumidor.
- A **Outbox** registra a intenção durável de publicar um evento.

São garantias complementares e devem ser testadas separadamente.

## 9. Regras de negócio

| Operação   | Efeito                       | Lançamento      | Regra principal                                                |
| ---------- | ---------------------------- | --------------- | -------------------------------------------------------------- |
| `BET`      | Débito                       | `DEBIT`         | Rejeitar se o saldo for insuficiente.                          |
| `WIN`      | Crédito                      | `CREDIT`        | Validar a referência quando fornecida e exigida pelo contrato. |
| `LOSS`     | Sem mudança de saldo         | Nenhum          | Registrar o resultado.                                         |
| `REFUND`   | Crédito                      | `CREDIT`        | Reverter uma `BET` processada uma única vez.                   |
| `ROLLBACK` | Efeito inverso da referência | Direção inversa | Reverter uma transação permitida uma única vez.                |

Regras adicionais:

- `REFUND` e `ROLLBACK` exigem uma referência externa.
- A referência é resolvida por `(providerId, referenceExternalTransactionId)`.
- A referência deve corresponder ao mesmo provider, player, wallet, moeda e rodada.
- `REFUND` só referencia `BET`.
- `ROLLBACK` pode referenciar `BET`, `WIN` ou `REFUND`.
- Uma transação pode ser diretamente revertida no máximo uma vez, independentemente do tipo de reversão (`REFUND` ou `ROLLBACK`). Reverter um `REFUND` não torna a aposta original elegível para uma segunda reversão.
- O valor de reversão deve ser igual ao da referência.
- Reversão que causaria saldo negativo deve ser rejeitada com `failureCode` específico.
- Operações rejeitadas não alteram saldo nem geram lançamento no ledger.

A implementação deve definir e testar a semântica exata de `WIN` e das referências opcionais conforme o contrato do desafio, sem permitir que ambiguidades levem a efeitos financeiros duplicados.

## 10. Mensageria, Inbox, retry e DLQ

### 10.1 Filas

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`

A infraestrutura local cria essas filas no LocalStack. O nome e a configuração de filas de eventos publicados pela outbox devem ser definidos de forma explícita no ambiente.

### 10.2 Consumidor

O consumidor deve:

1. validar o envelope e o contrato da mensagem;
2. abrir uma transação SQL;
3. registrar a mensagem na Inbox;
4. detectar uma mensagem já processada sem repetir seus efeitos;
5. invocar o mesmo `ProcessWagerUseCase` utilizado pela API;
6. persistir a Inbox, a transação, a wallet, o ledger e a outbox na mesma transação;
7. confirmar o commit;
8. executar ACK somente após o commit.

Se ocorrer falha antes do commit, a transação SQL é revertida e a mensagem deve continuar elegível para retry. Se o processo morrer após o commit e antes do ACK, a redelivery deve ser segura.

### 10.3 Classificação de falhas

- **Negócio terminal:** registrar `REJECTED` com `failureCode` estável e confirmar a mensagem quando o resultado terminal estiver persistido.
- **Transitória:** rollback e retry com backoff; não confirmar a mensagem antes de uma conclusão durável.
- **Permanente/irrecuperável:** aplicar a política documentada de tentativas e DLQ, preservando informação suficiente para diagnóstico sem registrar dados sensíveis.

O limite de tentativas, visibility timeout, redrive policy e backoff serão configurados e documentados. O shutdown gracioso deve concluir o trabalho em andamento ou permitir que a mensagem volte a ficar visível.

## 11. Transactional Outbox

A alteração financeira e a criação dos eventos correspondentes devem ser confirmadas na mesma transação SQL.

### 11.1 Eventos mínimos

- `WagerTransactionProcessed`: toda operação processada, inclusive `LOSS`.
- `WagerTransactionRejected`: operação rejeitada por regra de negócio.
- `WalletBalanceChanged`: somente quando o saldo mudar.
- `WagerTransactionPendingReference`: referência ainda ausente.

Os eventos terão envelope tipado com `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `causationId` opcional, `occurredAt` e `data`. Valores de `Money` são serializados como strings decimais, nunca como instâncias de classe.

### 11.2 Publicação concorrente

O publisher deve adquirir registros pendentes de forma concorrente e segura. A estratégia proposta é selecionar com `FOR UPDATE SKIP LOCKED` e usar claim/lease persistente com prazo de expiração, evitando que dois publishers trabalhem indefinidamente sobre o mesmo registro.

O publisher não deve manter uma transação SQL aberta durante a chamada de rede ao SQS. Depois da publicação, registra a confirmação; em falha, agenda retry com backoff.

### 11.3 Garantia e trade-off

A outbox garante que a intenção de publicar o evento não seja perdida após um commit financeiro. Ela não elimina a possibilidade de publicação duplicada: se o SQS aceitar a mensagem e o processo falhar antes de persistir a confirmação, o evento poderá ser publicado novamente.

Portanto, a entrega é tratada como **at-least-once**. Consumidores downstream devem ser idempotentes usando `eventId` ou uma chave equivalente. SQS FIFO é uma otimização adicional, não uma garantia de exatamente uma vez para o efeito de negócio.

## 12. Referências fora de ordem

Quando uma operação dependente chega antes da referência:

1. persistir a operação como `PENDING_REFERENCE`;
2. não alterar o saldo nem criar lançamento de ledger;
3. registrar o evento de pendência na outbox;
4. agendar nova tentativa com `nextAttemptAt` e backoff exponencial;
5. reprocessar por worker persistente, com aquisição concorrente segura;
6. ao encontrar a referência, validar as regras de domínio e processar dentro de uma transação;
7. ao esgotar tentativas ou TTL, transicionar para `REJECTED` com código de falha específico e emitir o evento correspondente.

O limite de tentativas e o TTL são decisões de configuração que precisam ser definidos antes da entrega. Timers em memória não serão a fonte de verdade para o agendamento.

## 13. API HTTP

Endpoints previstos:

| Método | Endpoint                                                              | Finalidade                                                                     |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/wallets`                                                            | Criar wallet e registrar `OPENING`/ledger quando o saldo inicial for positivo. |
| `GET`  | `/wallets/:walletId`                                                  | Consultar saldo e versão.                                                      |
| `GET`  | `/wallets/:walletId/ledger`                                           | Consultar ledger por cursor opaco e estável.                                   |
| `GET`  | `/wagering/transactions/:transactionId`                               | Consultar transação pelo ID interno.                                           |
| `GET`  | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar por identidade externa.                                              |
| `POST` | `/wagering/transactions`                                              | Submeter uma operação com `Idempotency-Key`.                                   |
| `POST` | `/wallets/:walletId/reconciliation`                                   | Comparar saldo materializado com o saldo calculado pelo ledger.                |
| `GET`  | `/health/live`                                                        | Verificar se o processo está vivo.                                             |
| `GET`  | `/health/ready`                                                       | Verificar dependências necessárias para operar.                                |

A API deve distinguir payload inválido, conflito de idempotência, rejeição de negócio, processamento pendente e falha transitória de infraestrutura com códigos HTTP consistentes e documentados.

Health checks não exigem autenticação. A reconciliação não corrige divergências silenciosamente: deve registrar logs, atualizar métricas e expor o resultado da comparação.

### 13.1 Paginação do ledger

A paginação será baseada em cursor estável e opaco, ordenado por uma combinação única e determinística, como `createdAt` e `id`. Não dependerá de offset para percorrer um ledger que pode crescer continuamente.

No Stage 2, a ordem implementada é crescente por `(created_at, id)`, com `timestamptz(3)` para preservar o cursor em `Date`. O cursor é base64url com versão e wallet, não um token de autorização; o limite padrão é 50 e valores maiores são limitados a 100. O contrato de criação é `{ playerId, currency, openingBalance }`, com UUID gerado internamente e resposta `201`. Os quatro endpoints de wallet e `/health/live` estão disponíveis; os demais permanecem planejados.

## 14. Autenticação e segurança

A autenticação não é pontuada diretamente pelo desafio. A opção preferencial, caso implementada, é integrar um Identity Provider externo como Keycloak usando OIDC, em vez de criar armazenamento próprio de senhas.

Se a autenticação não for implementada no timebox:

- documentar a decisão;
- deixar um ponto de extensão explícito, como guard/port de identidade;
- não simular segurança real com um guard que aceite qualquer usuário em ambiente exposto;
- manter health checks abertos conforme o contrato;
- tratar a identidade do provider presente nas mensagens como dado sujeito a validação de domínio.

Outras práticas:

- validar e limitar os contratos de entrada;
- não registrar payloads financeiros completos ou segredos;
- configurar credenciais por variáveis de ambiente;
- não incluir chaves ou credenciais no repositório;
- restringir os serviços locais às portas necessárias;
- validar autorização entre identidade do provedor e `providerId` quando a autenticação estiver ativa.

## 15. Observabilidade

### 15.1 Logs estruturados

Os logs devem ser JSON e incluir, quando disponíveis:

- `correlationId`;
- `messageId`;
- `transactionId`;
- `walletId`;
- `providerId`.

Não incluir dados sensíveis nem payloads financeiros completos. Os logs devem permitir seguir uma operação entre API, worker, banco e publicação de eventos.

### 15.2 Métricas mínimas

- transações por status e tipo;
- duplicatas/replays detectados;
- conflitos de idempotência;
- retries;
- mensagens em DLQ;
- duração/latência do processamento;
- conflitos de locking e retries por concorrência;
- quantidade de mensagens pendentes na outbox;
- atraso da outbox;
- divergências de reconciliação.

### 15.3 Health checks

- `live`: confirma que o processo está vivo.
- `ready`: verifica PostgreSQL e SQS conforme as dependências necessárias para o processo.

A indisponibilidade de uma dependência deve afetar readiness quando ela impede o processo de cumprir sua função. Health endpoints permanecem sem autenticação.

## 16. Estratégia de testes

Os testes de integração usam PostgreSQL e LocalStack reais em containers. Mocks podem ser usados em testes unitários de componentes isolados, mas não substituem os testes de integração e concorrência exigidos.

### 16.1 Testes unitários

- `Money`: escala, valores inválidos, comparação, aritmética e moedas diferentes.
- `Wallet`: saldo não negativo, versão e transições.
- `WagerTransaction`: transições válidas, estados terminais e referências.
- `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Reversão duplicada e saldo insuficiente.
- Idempotency key com payload divergente.
- Validação da aritmética do lançamento.

### 16.2 Testes de integração

- migrations e constraints;
- atomicidade de wallet, transação, ledger, inbox e outbox;
- deduplicação e redelivery;
- publisher concorrente;
- retry e DLQ;
- recuperação após reinicialização;
- reconciliação;
- API e códigos de resposta.

### 16.3 Testes de concorrência e falha

1. A mesma aposta enviada 50 vezes em paralelo: um único débito.
2. Duas apostas de `80.00 BRL` concorrentes contra saldo `100.00 BRL`: uma processada, outra rejeitada, saldo final `20.00 BRL` e um único débito.
3. Operações de wallets diferentes em paralelo.
4. Três ou mais instâncias simultâneas.
5. Worker encerrado depois do commit e antes do ACK.
6. Dois publishers disputando registros da mesma outbox.
7. `REFUND` ou `ROLLBACK` antes da referência.
8. Reinício do serviço com comprovação de consistência final.
9. Indisponibilidade temporária de PostgreSQL ou SQS.
10. Reconstrução do saldo pelo ledger após os cenários.

### 16.4 Invariante final

Após cada cenário de teste, verificar:

`wallet.balance == saldo reconstruído pelo ledger`

O saldo reconstruído é a soma assinada de todos os lançamentos, partindo de zero e incluindo o crédito `OPENING` quando presente. Se o cálculo partir do saldo inicial, deve excluir `OPENING` da soma para não contar a abertura duas vezes.

Também verificar estados das transações, quantidade e direção dos lançamentos, e ausência de eventos perdidos no fluxo de outbox.

## 17. Ambiente local e execução

O Docker Compose deve provisionar os serviços necessários para desenvolvimento e integração:

- API;
- worker de consumo SQS;
- publisher da outbox;
- reprocessador de referências (pode compartilhar o processo worker);
- PostgreSQL;
- LocalStack;
- Keycloak somente se a autenticação for implementada.

Os processos de aplicação podem usar a mesma imagem e receber comandos de inicialização diferentes. A configuração deve ser feita por variáveis de ambiente, com valores locais documentados e sem credenciais reais no repositório.

O README do projeto deve documentar:

1. pré-requisitos;
2. configuração de ambiente;
3. inicialização do Docker Compose;
4. criação/configuração das filas SQS locais;
5. execução das migrations;
6. inicialização dos processos;
7. execução dos testes unitários, de integração e concorrência;
8. exemplos de chamadas HTTP;
9. como inspecionar logs e métricas.

## 18. Trade-offs e limitações

### Decisões adotadas

- **Monólito modular em vez de microserviços:** reduz complexidade operacional e mantém a transação financeira em uma única fronteira de persistência.
- **Pessimistic locking por wallet:** torna explícita a serialização de operações sobre o mesmo saldo; pode reduzir throughput em wallets muito concorridas.
- **PostgreSQL como fonte de verdade:** constraints e transações dão garantias persistentes entre instâncias.
- **Inbox + idempotência:** a inbox deduplica entregas de mensagens; a idempotência protege o efeito financeiro independentemente do canal.
- **Outbox transacional:** evita perder a intenção de publicar eventos, aceitando que a publicação possa ser duplicada.
- **SQS at-least-once:** o processamento é projetado para suportar redelivery, em vez de presumir entrega única.
- **Observabilidade enxuta:** logs e métricas essenciais primeiro; tracing e dashboards completos são opcionais.

### Limitações conhecidas

- Uma wallet muito concorrida pode se tornar um ponto quente por causa do lock por linha.
- A outbox pode apresentar atraso durante indisponibilidades do broker.
- Entrega duplicada de eventos continua possível e precisa ser tolerada pelos consumidores.
- Os valores de TTL, limite de tentativas e visibility timeout precisam ser calibrados e documentados.
- O uso operacional pode limitar-se a BRL no desafio, embora o domínio continue validando moedas.
- Autenticação pode ficar fora da implementação inicial, desde que a decisão e o ponto de extensão estejam explícitos.

## 19. Critérios de conclusão

A implementação será considerada pronta para avaliação quando:

- [ ] a API e os workers iniciarem pelo procedimento documentado;
- [ ] migrations e constraints puderem ser aplicadas em banco limpo;
- [ ] o domínio não usar `number` para dinheiro;
- [ ] o saldo não puder ficar negativo por concorrência;
- [ ] idempotência persistente sobreviver a reinícios;
- [ ] wallet, transação, ledger, inbox e outbox forem atômicos quando aplicável;
- [ ] eventos não forem publicados antes do commit;
- [ ] mensagens duplicadas e reentregues não duplicarem efeitos financeiros;
- [ ] referências fora de ordem forem reprocessadas de forma persistente;
- [ ] testes de concorrência rodarem contra PostgreSQL e SQS local reais;
- [ ] três ou mais instâncias puderem operar sobre as mesmas dependências;
- [ ] a reconciliação identificar divergências sem corrigi-las silenciosamente;
- [ ] logs, métricas e health checks obrigatórios estiverem disponíveis;
- [ ] `README.md` e este documento descreverem a implementação real, os trade-offs e as limitações.

---

**Nota de implementação:** se uma decisão descrita aqui mudar durante o desenvolvimento, atualize este documento para refletir o comportamento efetivamente implementado. A documentação deve explicar o sistema real e não declarar garantias que ainda não foram demonstradas por código e testes.
