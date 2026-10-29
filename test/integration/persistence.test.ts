import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { WalletRecord } from "../../src/database/entities";
import { WalletService } from "../../src/modules/wallets/application/wallet-service";
import { PostgresWalletRepository } from "../../src/modules/wallets/infrastructure/postgres-wallet-repository";
import { PostgresLedgerRepository } from "../../src/modules/ledger/infrastructure/postgres-ledger-repository";
import { Wallet } from "../../src/modules/wallets/domain/entities/wallet";
import { Money } from "../../src/modules/wallets/domain/value-objects/money";
import { WalletAlreadyExistsError } from "../../src/modules/wallets/application/wallet-errors";
import { ReconciliationMonitor } from "../../src/modules/wallets/presentation/http/reconciliation-monitor";
import { createTestDatabase } from "./database-fixture";

describe("Stage 2 / real PostgreSQL persistence", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let wallets: PostgresWalletRepository;
  let ledger: PostgresLedgerRepository;
  let service: WalletService;
  let app: INestApplication | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.orm.getMigrator().up();
    wallets = new PostgresWalletRepository(database.orm);
    ledger = new PostgresLedgerRepository(database.orm);
    service = new WalletService(wallets, ledger);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
  }, 30_000);

  const open = (amount = "0.00") =>
    service.create({
      playerId: randomUUID(),
      currency: "BRL",
      openingBalance: amount,
    });

  const execute = <T extends object[] = object[]>(
    sql: string,
    params: unknown[] = [],
  ) => database.orm.em.fork().getConnection().execute<T>(sql, params);

  async function insertWager(input: {
    wallet: Wallet;
    id?: string;
    providerId?: string;
    externalId?: string;
    key?: string;
    kind?: string;
    status?: string;
    referenceId?: string;
    amount?: string;
    at?: string;
  }) {
    const id = input.id ?? randomUUID();
    const status = input.status ?? "PROCESSED";
    await execute(
      `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, currency, round_id, game_id, kind, status, amount,
        reference_external_transaction_id, reference_transaction_id, created_at, completed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.providerId ?? randomUUID(),
        input.externalId ?? randomUUID(),
        input.key ?? randomUUID(),
        "a".repeat(64),
        input.wallet.id,
        input.wallet.playerId,
        input.wallet.currency,
        "round-1",
        "game-1",
        input.kind ?? "BET",
        status,
        input.amount ?? "1.00",
        input.referenceId ? "reference-external" : null,
        input.referenceId ?? null,
        input.at ?? "2026-10-29T12:00:00.000Z",
        status === "PROCESSED" ? "2026-10-29T12:00:00.000Z" : null,
      ],
    );
    return id;
  }

  async function insertEntry(
    wallet: Wallet,
    transactionId: string,
    options: {
      id?: string;
      amount?: string;
      before?: string;
      after?: string;
      direction?: string;
      at?: string;
    } = {},
  ) {
    const id = options.id ?? randomUUID();
    await execute(
      `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, currency, amount, direction, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        wallet.id,
        transactionId,
        wallet.currency,
        options.amount ?? "1.00",
        options.direction ?? "CREDIT",
        options.before ?? "0.00",
        options.after ?? "1.00",
        options.at ?? "2026-10-29T12:00:00.000Z",
      ],
    );
    return id;
  }

  test("migration upgrades, safely downgrades an empty schema, and upgrades again", async () => {
    expect(
      await database.orm.getMigrator().getExecutedMigrations(),
    ).toHaveLength(1);
    await database.orm.getMigrator().down();
    const tables = await execute<{ name: string | null }[]>(
      "select to_regclass('wallets')::text as name",
    );
    expect(tables[0]?.name).toBeNull();
    await database.orm.getMigrator().up();
    expect(
      await database.orm.getMigrator().getExecutedMigrations(),
    ).toHaveLength(1);
  });

  test("positive opening is atomic and round-trips exact money above JS integer precision", async () => {
    const amount = "90071992547409931234567890.12";
    const wallet = await open(amount);
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe(
      amount,
    );
    const page = await service.listLedger(wallet.id);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.direction).toBe("CREDIT");
    expect(page.entries[0]?.balanceBefore.toString()).toBe("0.00");
    expect(page.entries[0]?.balanceAfter.toString()).toBe(amount);
    const records = await execute<{ kind: string; status: string }[]>(
      "select kind, status from wager_transactions where wallet_id = ?",
      [wallet.id],
    );
    expect(records).toEqual([{ kind: "OPENING", status: "PROCESSED" }]);
    expect(await service.reconcile(wallet.id)).toMatchObject({
      storedBalance: amount,
      calculatedBalance: amount,
      difference: "0.00",
      consistent: true,
      checkedEntries: 1,
    });
  });

  test("zero opening creates neither a transaction nor ledger entry", async () => {
    const wallet = await open();
    expect(wallet.version).toBe(1);
    expect(await service.listLedger(wallet.id)).toEqual({
      entries: [],
      nextCursor: null,
    });
    const transactions = await execute<{ id: string }[]>(
      "select id from wager_transactions where wallet_id = ?",
      [wallet.id],
    );
    expect(transactions).toHaveLength(0);
    expect(await service.reconcile(wallet.id)).toMatchObject({
      calculatedBalance: "0.00",
      checkedEntries: 0,
      consistent: true,
    });
  });

  test("persisted money accepts the exact NUMERIC(38,2) maximum and rejects overflow", async () => {
    const maximum = `${"9".repeat(36)}.99`;
    const wallet = await open(maximum);
    expect((await service.get(wallet.id)).balance.toString()).toBe(maximum);
    await expect(open(`${"1".repeat(37)}.00`)).rejects.toThrow(
      "36 integer digits",
    );
    await expect(
      execute("update wallets set balance = ? where id = ?", [
        `${"1".repeat(37)}.00`,
        wallet.id,
      ]),
    ).rejects.toMatchObject({ code: "22003" });
    const em = database.orm.em.fork();
    const row = await em.findOneOrFail(WalletRecord, { id: wallet.id });
    row.balance = "1.001";
    await expect(em.flush()).rejects.toThrow();
    expect((await service.get(wallet.id)).balance.toString()).toBe(maximum);
  });

  test("database and repository reject duplicate wallets, including a creation race", async () => {
    const playerId = randomUUID();
    const results = await Promise.allSettled([
      service.create({ playerId, currency: "BRL", openingBalance: "10.00" }),
      service.create({ playerId, currency: "BRL", openingBalance: "10.00" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    const counts = await execute<{ wallets: string; ledger: string }[]>(
      `select count(distinct w.id)::text as wallets, count(l.id)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.player_id = ?`,
      [playerId],
    );
    expect(counts).toEqual([{ wallets: "1", ledger: "1" }]);
  });

  test("database rejects negative balances, invalid versions and orphaned transactions", async () => {
    const wallet = await open();
    await expect(
      execute("update wallets set balance = -0.01 where id = ?", [wallet.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      execute("update wallets set version = 0 where id = ?", [wallet.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const fake = Wallet.rehydrate({
      id: randomUUID(),
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: "0.00",
      version: 1,
    });
    await expect(insertWager({ wallet: fake })).rejects.toMatchObject({
      code: "23503",
    });
  });

  test("database enforces independent external and idempotency uniqueness", async () => {
    const wallet = await open();
    const providerId = randomUUID();
    const externalId = randomUUID();
    const key = randomUUID();
    await insertWager({ wallet, providerId, externalId, key });
    await expect(
      insertWager({ wallet, providerId, externalId }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insertWager({ wallet, providerId, key }),
    ).rejects.toMatchObject({ code: "23505" });
    await insertWager({ wallet, externalId, key });
  });

  test("processed REFUND and ROLLBACK share a unique direct reversal reference", async () => {
    const wallet = await open();
    const referenceId = await insertWager({ wallet });
    await insertWager({ wallet, kind: "REFUND", referenceId });
    await expect(
      insertWager({ wallet, kind: "ROLLBACK", referenceId }),
    ).rejects.toMatchObject({ code: "23505" });
    const pending = await insertWager({
      wallet,
      kind: "ROLLBACK",
      status: "PENDING",
      referenceId,
    });
    await expect(
      execute(
        "update wager_transactions set status = 'PROCESSED', completed_at = now() where id = ?",
        [pending],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insertWager({ wallet, kind: "ROLLBACK" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("concurrent reversal inserts are arbitrated by PostgreSQL across kinds", async () => {
    const wallet = await open();
    const referenceId = await insertWager({ wallet });
    const results = await Promise.allSettled([
      insertWager({ wallet, kind: "REFUND", referenceId }),
      insertWager({ wallet, kind: "ROLLBACK", referenceId }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "23505",
    });
  });

  test("database validates wager kind, status, failure codes and one internal opening", async () => {
    const wallet = await open("2.00");
    await expect(
      insertWager({ wallet, kind: "UNKNOWN" }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertWager({ wallet, status: "UNKNOWN" }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertWager({ wallet, amount: "-1.00" }),
    ).rejects.toMatchObject({ code: "23514" });
    const transaction = await insertWager({ wallet });
    await expect(
      execute(
        "update wager_transactions set failure_code = 'INSUFFICIENT_FUNDS' where id = ?",
        [transaction],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const pending = await insertWager({ wallet, status: "PENDING" });
    await expect(
      execute(
        "update wager_transactions set status = 'FAILED', failure_code = 'INSUFFICIENT_FUNDS', completed_at = now() where id = ?",
        [pending],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      execute(
        `insert into wager_transactions
       (id, wallet_id, player_id, currency, kind, status, amount, created_at, completed_at)
       values (?, ?, ?, 'BRL', 'OPENING', 'PROCESSED', 2.00, now(), now())`,
        [randomUUID(), wallet.id, wallet.playerId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("ledger rejects duplicate transactions, bad equations, negative balances and cross-wallet rows", async () => {
    const wallet = await open();
    const transaction = await insertWager({ wallet });
    await insertEntry(wallet, transaction);
    await expect(insertEntry(wallet, transaction)).rejects.toMatchObject({
      code: "23505",
    });
    const otherTransaction = await insertWager({ wallet });
    await expect(
      insertEntry(wallet, otherTransaction, { after: "2.00" }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertEntry(wallet, otherTransaction, { before: "-1.00", after: "0.00" }),
    ).rejects.toMatchObject({ code: "23514" });
    const otherWallet = await open();
    await expect(
      insertEntry(otherWallet, otherTransaction),
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("ledger UPDATE, DELETE and TRUNCATE are blocked by database triggers", async () => {
    const wallet = await open("2.00");
    const entry = (await service.listLedger(wallet.id)).entries[0];
    expect(entry).toBeDefined();
    await expect(
      execute("update wallet_ledger_entries set amount = 3.00 where id = ?", [
        entry?.id,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      execute("delete from wallet_ledger_entries where id = ?", [entry?.id]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      execute("truncate wallet_ledger_entries"),
    ).rejects.toMatchObject({ code: "P0001" });
    expect((await service.listLedger(wallet.id)).entries).toHaveLength(1);
  });

  test("a ledger failure rolls back wallet and opening transaction too", async () => {
    const existing = await open("1.00");
    const duplicate = (await service.listLedger(existing.id)).entries[0];
    const id = randomUUID();
    const opening = Wallet.open({
      id,
      playerId: randomUUID(),
      currency: "BRL",
      openingBalance: Money.parse("50.00", "BRL"),
      openingTransactionId: randomUUID(),
      openingLedgerEntryId: duplicate?.id ?? "",
      openedAt: new Date(),
    });
    await expect(wallets.create(opening)).rejects.toMatchObject({
      code: "23505",
    });
    expect(await wallets.findById(id)).toBeNull();
    expect(
      await execute<{ id: string }[]>(
        "select id from wager_transactions where wallet_id = ?",
        [id],
      ),
    ).toHaveLength(0);
  });

  test("one MikroORM transaction rolls back financial, inbox and outbox writes together", async () => {
    const wallet = await open();
    const transactionId = randomUUID();
    const entryId = randomUUID();
    const eventId = randomUUID();
    const messageId = randomUUID();
    const injected = new Error("Injected failure after all five writes");
    await expect(
      database.orm.em.fork().transactional(async (em) => {
        await em.execute(
          "update wallets set balance = 50.00, version = 2 where id = ?",
          [wallet.id],
        );
        await em.execute(
          `insert into wager_transactions
           (id, wallet_id, player_id, currency, kind, status, amount, created_at, completed_at)
           values (?, ?, ?, 'BRL', 'OPENING', 'PROCESSED', 50.00, now(), now())`,
          [transactionId, wallet.id, wallet.playerId],
        );
        await em.execute(
          `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, currency, amount, direction, balance_before, balance_after, created_at)
           values (?, ?, ?, 'BRL', 50.00, 'CREDIT', 0.00, 50.00, now())`,
          [entryId, wallet.id, transactionId],
        );
        await em.execute(
          `insert into inbox_messages (consumer_name, message_id, payload_hash, status, received_at, completed_at)
           values ('stage2-test', ?, ?, 'COMPLETED', now(), now())`,
          [messageId, "a".repeat(64)],
        );
        await em.execute(
          `insert into outbox_messages
           (event_id, event_type, aggregate_id, payload, status, next_attempt_at, created_at)
           values (?, 'WalletBalanceChanged', ?, '{}', 'PENDING', now(), now())`,
          [eventId, wallet.id],
        );
        throw injected;
      }),
    ).rejects.toBe(injected);
    expect((await service.get(wallet.id)).balance.toString()).toBe("0.00");
    expect((await service.get(wallet.id)).version).toBe(1);
    const counts = await execute<
      {
        transactions: string;
        ledger: string;
        inbox: string;
        outbox: string;
      }[]
    >(
      `select
         (select count(*)::text from wager_transactions where id = ?) as transactions,
         (select count(*)::text from wallet_ledger_entries where id = ?) as ledger,
         (select count(*)::text from inbox_messages where message_id = ?) as inbox,
         (select count(*)::text from outbox_messages where event_id = ?) as outbox`,
      [transactionId, entryId, messageId, eventId],
    );
    expect(counts).toEqual([
      { transactions: "0", ledger: "0", inbox: "0", outbox: "0" },
    ]);
  });

  test("inbox consumer/message identity and outbox event identity are unique", async () => {
    const messageId = randomUUID();
    const insertInbox = (consumer: string) =>
      execute(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, status, received_at)
         values (?, ?, ?, 'PROCESSING', now())`,
        [consumer, messageId, "a".repeat(64)],
      );
    await insertInbox("consumer-1");
    await expect(insertInbox("consumer-1")).rejects.toMatchObject({
      code: "23505",
    });
    await insertInbox("consumer-2");
    const eventId = randomUUID();
    const insertOutbox = () =>
      execute(
        `insert into outbox_messages (event_id, event_type, aggregate_id, payload, status, next_attempt_at, created_at)
         values (?, 'WalletBalanceChanged', 'wallet', '{}', 'PENDING', now(), now())`,
        [eventId],
      );
    await insertOutbox();
    await expect(insertOutbox()).rejects.toMatchObject({ code: "23505" });
  });

  test("cursor pagination handles tied timestamps without duplicates or omissions", async () => {
    const wallet = await open();
    const ids = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    for (const id of ids) {
      const transactionId = await insertWager({ wallet });
      await insertEntry(wallet, transactionId, { id });
    }
    const first = await service.listLedger(wallet.id, { limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(
      [...ids].sort().slice(0, 2),
    );
    expect(first.nextCursor).toBeString();
    const second = await service.listLedger(wallet.id, {
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(
      [...ids].sort().slice(2),
    );
    expect(second.nextCursor).toBeNull();
    const differentWallet = await open();
    await expect(
      service.listLedger(differentWallet.id, {
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toThrow("Invalid ledger cursor");
    await expect(
      service.listLedger(wallet.id, { cursor: "invalid" }),
    ).rejects.toThrow("Invalid ledger cursor");
    await expect(service.listLedger(wallet.id, { limit: 0 })).rejects.toThrow(
      "positive integer",
    );
  });

  test("pagination defaults to 50 and caps the requested size at 100", async () => {
    const wallet = await open();
    for (let index = 0; index < 101; index++) {
      await insertEntry(wallet, await insertWager({ wallet }));
    }
    expect((await service.listLedger(wallet.id)).entries).toHaveLength(50);
    const first = await service.listLedger(wallet.id, { limit: 1000 });
    expect(first.entries).toHaveLength(100);
    const last = await service.listLedger(wallet.id, {
      cursor: first.nextCursor ?? "",
    });
    expect(last.entries).toHaveLength(1);
  }, 15_000);

  test("reconciliation sums opening and later credits/debits once and reports discrepancies without repair", async () => {
    const wallet = await open("100.00");
    await insertEntry(wallet, await insertWager({ wallet, amount: "20.00" }), {
      amount: "20.00",
      before: "100.00",
      after: "80.00",
      direction: "DEBIT",
    });
    await insertEntry(
      wallet,
      await insertWager({ wallet, kind: "WIN", amount: "5.00" }),
      {
        amount: "5.00",
        before: "80.00",
        after: "85.00",
      },
    );
    await execute(
      "update wallets set balance = 85.00, version = 3 where id = ?",
      [wallet.id],
    );
    expect(await service.reconcile(wallet.id)).toMatchObject({
      storedBalance: "85.00",
      calculatedBalance: "85.00",
      difference: "0.00",
      consistent: true,
      checkedEntries: 3,
    });
    await execute("update wallets set balance = 90.00 where id = ?", [
      wallet.id,
    ]);
    expect(await service.reconcile(wallet.id)).toMatchObject({
      storedBalance: "90.00",
      calculatedBalance: "85.00",
      difference: "5.00",
      consistent: false,
      checkedEntries: 3,
    });
    expect((await service.get(wallet.id)).balance.toString()).toBe("90.00");
  });

  test("down migration refuses populated schema and preserves financial rows", async () => {
    const wallet = await open("42.00");
    await expect(database.orm.getMigrator().down()).rejects.toThrow();
    expect((await service.get(wallet.id)).balance.toString()).toBe("42.00");
    expect((await service.listLedger(wallet.id)).entries).toHaveLength(1);
    expect(
      await database.orm.getMigrator().getExecutedMigrations(),
    ).toHaveLength(1);
  });

  test("HTTP wallet lifecycle, stable errors and reconciliation counter use real persistence", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      app = await NestFactory.create(AppModule, {
        logger: false,
        abortOnError: false,
      });
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    const playerId = randomUUID();
    const request = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await request("/wallets", {
      playerId,
      currency: "BRL",
      openingBalance: "10.00",
    });
    expect(response.status).toBe(201);
    const wallet = (await response.json()) as {
      id: string;
      balance: string;
      version: number;
    };
    expect(wallet).toMatchObject({ balance: "10.00", version: 1 });
    const read = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject(wallet);
    const page = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    expect(await page.json()).toMatchObject({
      entries: [
        {
          amount: "10.00",
          currency: "BRL",
          balanceBefore: "0.00",
          balanceAfter: "10.00",
        },
      ],
      nextCursor: null,
    });
    expect(
      (
        await request("/wallets", {
          playerId,
          currency: "BRL",
          openingBalance: "0.00",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/wallets", {
          playerId,
          currency: "BRL",
          openingBalance: "1.001",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/wallets", {
          playerId,
          currency: "BRL",
          openingBalance: "1.00",
          unexpected: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/wallets", {
          playerId,
          currency: "ZZZ",
          openingBalance: "1.00",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/not-a-uuid`)).status).toBe(400);
    const missing = await fetch(`${baseUrl}/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      code: "WALLET_NOT_FOUND",
      message: "Wallet not found.",
    });
    expect(
      (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=-1`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=invalid`))
        .status,
    ).toBe(400);
    const reconciliation = await request(
      `/wallets/${wallet.id}/reconciliation`,
      {},
    );
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      checkedEntries: 1,
    });
    await execute("update wallets set balance = 11.00 where id = ?", [
      wallet.id,
    ]);
    const before = app.get(ReconciliationMonitor).discrepancyCount;
    const mismatch = await request(`/wallets/${wallet.id}/reconciliation`, {});
    expect(await mismatch.json()).toMatchObject({
      consistent: false,
      difference: "1.00",
    });
    expect(app.get(ReconciliationMonitor).discrepancyCount).toBe(before + 1);
    expect((await service.get(wallet.id)).balance.toString()).toBe("11.00");
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  }, 15_000);
});
