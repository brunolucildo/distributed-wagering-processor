import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { createTestDatabase } from "./database-fixture";
import { PostgresWalletRepository } from "../../src/modules/wallets/infrastructure/postgres-wallet-repository";
import { PostgresLedgerRepository } from "../../src/modules/ledger/infrastructure/postgres-ledger-repository";
import { WalletService } from "../../src/modules/wallets/application/wallet-service";

type Submission = {
  transactionId: string;
  status: string;
  failureCode?: string;
  walletBalance: string;
  idempotentReplay: boolean;
};

describe("Stage 3 / wagering API and idempotency", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: INestApplication | undefined;
  let baseUrl: string;
  let wallets: WalletService;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.orm.getMigrator().up();
    wallets = new WalletService(
      new PostgresWalletRepository(database.orm),
      new PostgresLedgerRepository(database.orm),
    );
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
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
  }, 30_000);

  const createWallet = (openingBalance = "0.00") =>
    wallets.create({
      playerId: randomUUID(),
      currency: "BRL",
      openingBalance,
    });

  function wager(
    walletId: string,
    values: Partial<{
      providerId: string;
      externalTransactionId: string;
      playerId: string;
      roundId: string;
      gameId: string;
      kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK" | "OPENING";
      amount: string;
      currency: string;
      referenceExternalTransactionId: string;
    }> = {},
  ) {
    return {
      providerId: values.providerId ?? "provider-stage3",
      externalTransactionId: values.externalTransactionId ?? randomUUID(),
      playerId: values.playerId ?? randomUUID(),
      walletId,
      roundId: values.roundId ?? "round-stage3",
      gameId: values.gameId ?? "game-stage3",
      kind: values.kind ?? "BET",
      money: {
        amount: values.amount ?? "1.00",
        currency: values.currency ?? "BRL",
      },
      ...(values.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              values.referenceExternalTransactionId,
          }
        : {}),
    };
  }

  async function submit(
    body: unknown,
    key: string = randomUUID(),
  ): Promise<{ status: number; body: Submission | Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  const execute = <T extends object[] = object[]>(
    sql: string,
    params: unknown[] = [],
  ) => database.orm.em.fork().getConnection().execute<T>(sql, params);

  async function countForWallet(
    table: string,
    walletId: string,
  ): Promise<number> {
    if (
      ![
        "wager_transactions",
        "wallet_ledger_entries",
        "outbox_messages",
      ].includes(table)
    ) {
      throw new Error("Unsupported table in integration-test helper.");
    }
    const rows = await execute<{ count: string }[]>(
      table === "outbox_messages"
        ? `select count(*)::text as count from outbox_messages
           where aggregate_id = ? or payload->'data'->>'walletId' = ?`
        : `select count(*)::text as count from ${table} where wallet_id = ?`,
      table === "outbox_messages" ? [walletId, walletId] : [walletId],
    );
    return Number(rows[0]?.count ?? "0");
  }

  test("processes a BET atomically and persists the matching ledger and outbox", async () => {
    const wallet = await createWallet("100.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "bet-atomic-1",
      amount: "30.00",
    });
    const response = await submit(request, "key-atomic-1");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "PROCESSED",
      walletBalance: "70.00",
      idempotentReplay: false,
    });
    expect(await wallets.get(wallet.id)).toMatchObject({
      balance: { currency: "BRL" },
      version: 2,
    });
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("70.00");
    expect(await countForWallet("wager_transactions", wallet.id)).toBe(2);
    expect(await countForWallet("wallet_ledger_entries", wallet.id)).toBe(2);
    expect(await countForWallet("outbox_messages", wallet.id)).toBe(2);
    const eventRows = await execute<{ event_type: string }[]>(
      `select event_type from outbox_messages
       where aggregate_id = ? or payload->'data'->>'walletId' = ?
       order by event_type`,
      [(response.body as Submission).transactionId, wallet.id],
    );
    expect(eventRows.map((row) => row.event_type).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("replay returns the original response snapshot after the wallet changes", async () => {
    const wallet = await createWallet("50.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "snapshot-bet",
      amount: "10.00",
    });
    const first = await submit(request, "snapshot-key");
    expect(first.status).toBe(200);
    const later = await submit(
      wager(wallet.id, {
        playerId: wallet.playerId,
        externalTransactionId: "snapshot-win",
        kind: "WIN",
        amount: "7.00",
      }),
      "snapshot-win-key",
    );
    expect(later.body).toMatchObject({ walletBalance: "47.00" });
    const replay = await submit(request, "snapshot-key");
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({
      ...(first.body as Submission),
      idempotentReplay: true,
    });
    expect((replay.body as Submission).walletBalance).toBe("40.00");
  });

  test("same key with changed payload and same external ID with a new key conflict", async () => {
    const wallet = await createWallet("30.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "identity-conflict",
      amount: "5.00",
    });
    expect((await submit(request, "identity-conflict-key")).status).toBe(200);
    expect(
      (
        await submit(
          { ...request, money: { amount: "6.00", currency: "BRL" } },
          "identity-conflict-key",
        )
      ).status,
    ).toBe(409);
    expect((await submit(request, "different-key")).status).toBe(409);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("25.00");
    expect(await countForWallet("wallet_ledger_entries", wallet.id)).toBe(2);
  });

  test("key scoped to a provider permits the same key for another provider", async () => {
    const wallet = await createWallet();
    const first = await submit(
      wager(wallet.id, {
        providerId: "provider-one",
        playerId: wallet.playerId,
        externalTransactionId: "provider-one-tx",
        kind: "LOSS",
      }),
      "shared-key",
    );
    const second = await submit(
      wager(wallet.id, {
        providerId: "provider-two",
        playerId: wallet.playerId,
        externalTransactionId: "provider-two-tx",
        kind: "LOSS",
      }),
      "shared-key",
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as Submission).transactionId).not.toBe(
      (second.body as Submission).transactionId,
    );
  });

  test("LOSS, WIN, REFUND and ROLLBACK persist expected balance effects", async () => {
    const wallet = await createWallet("100.00");
    const loss = await submit(
      wager(wallet.id, {
        playerId: wallet.playerId,
        kind: "LOSS",
        externalTransactionId: "rules-loss",
      }),
    );
    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({
      status: "PROCESSED",
      walletBalance: "100.00",
    });
    expect(await wallets.get(wallet.id).then((value) => value.version)).toBe(1);

    const betId = "rules-bet";
    expect(
      (
        await submit(
          wager(wallet.id, {
            playerId: wallet.playerId,
            externalTransactionId: betId,
            amount: "10.00",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await submit(
          wager(wallet.id, {
            playerId: wallet.playerId,
            externalTransactionId: "rules-refund",
            kind: "REFUND",
            amount: "10.00",
            referenceExternalTransactionId: betId,
          }),
        )
      ).body,
    ).toMatchObject({ walletBalance: "100.00" });
    expect(
      (
        await submit(
          wager(wallet.id, {
            playerId: wallet.playerId,
            externalTransactionId: "rules-rollback-refund",
            kind: "ROLLBACK",
            amount: "10.00",
            referenceExternalTransactionId: "rules-refund",
          }),
        )
      ).body,
    ).toMatchObject({ walletBalance: "90.00" });
    const winId = "rules-win";
    expect(
      (
        await submit(
          wager(wallet.id, {
            playerId: wallet.playerId,
            externalTransactionId: winId,
            kind: "WIN",
            amount: "7.00",
            referenceExternalTransactionId: betId,
          }),
        )
      ).body,
    ).toMatchObject({ walletBalance: "97.00" });
    expect(
      (
        await submit(
          wager(wallet.id, {
            playerId: wallet.playerId,
            externalTransactionId: "rules-rollback-win",
            kind: "ROLLBACK",
            amount: "7.00",
            referenceExternalTransactionId: winId,
          }),
        )
      ).body,
    ).toMatchObject({ walletBalance: "90.00" });
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("90.00");
    expect(await serviceLedgerCount(wallet.id)).toBe(6);
  });

  async function serviceLedgerCount(walletId: string): Promise<number> {
    return countForWallet("wallet_ledger_entries", walletId);
  }

  test("missing references are durably pending and emit the pending-reference outbox event", async () => {
    const wallet = await createWallet();
    const response = await submit(
      wager(wallet.id, {
        playerId: wallet.playerId,
        kind: "WIN",
        externalTransactionId: "pending-win",
        referenceExternalTransactionId: "not-arrived-yet",
      }),
      "pending-win-key",
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "PENDING_REFERENCE",
      walletBalance: "0.00",
    });
    const rows = await execute<
      {
        status: string;
        next_retry_at: Date;
        pending_reference_expires_at: Date;
      }[]
    >(
      `select status, next_retry_at, pending_reference_expires_at
       from wager_transactions where external_transaction_id = 'pending-win'`,
    );
    expect(rows[0]?.status).toBe("PENDING_REFERENCE");
    expect(rows[0]?.next_retry_at).toBeTruthy();
    expect(rows[0]?.pending_reference_expires_at).toBeTruthy();
    expect(
      await execute<{ event_type: string }[]>(
        `select event_type from outbox_messages
       where event_type = 'WagerTransactionPendingReference'
         and payload->'data'->>'transactionId' = ?`,
        [(response.body as Submission).transactionId],
      ),
    ).toHaveLength(1);
    expect(
      await wallets.get(wallet.id).then((value) => value.balance.toString()),
    ).toBe("0.00");
    expect(await serviceLedgerCount(wallet.id)).toBe(0);
  });

  test("business rejection commits a durable terminal outcome and does not change balance", async () => {
    const wallet = await createWallet("0.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "insufficient-bet",
      amount: "1.00",
    });
    const response = await submit(request, "insufficient-key");
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      walletBalance: "0.00",
    });
    const replay = await submit(request, "insufficient-key");
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      ...(response.body as Submission),
      idempotentReplay: true,
    });
    const rows = await execute<{ status: string; failure_code: string }[]>(
      "select status, failure_code from wager_transactions where external_transaction_id = 'insufficient-bet'",
    );
    expect(rows).toEqual([
      { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
    ]);
    expect(await serviceLedgerCount(wallet.id)).toBe(0);
  });

  test("currency-mismatch rejection is durable and blocks an unsafe identity-migration rollback", async () => {
    const wallet = await createWallet("20.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "currency-mismatch",
      currency: "USD",
      amount: "5.00",
    });
    const response = await submit(request, "currency-mismatch-key");
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: "REJECTED",
      failureCode: "CURRENCY_MISMATCH",
      walletBalance: "20.00",
    });
    expect((await wallets.get(wallet.id)).version).toBe(1);
    expect(await serviceLedgerCount(wallet.id)).toBe(1);
    expect(
      await execute<{ status: string; failure_code: string }[]>(
        `select status, failure_code from wager_transactions
         where external_transaction_id = 'currency-mismatch'`,
      ),
    ).toEqual([{ status: "REJECTED", failure_code: "CURRENCY_MISMATCH" }]);
    await expect(
      database.orm.getMigrator().down({ to: "RejectNonFiniteMoney" }),
    ).rejects.toThrow(
      "Refusing to restore wallet-currency constraint while rejected currency-mismatch transactions exist",
    );
    expect(
      await database.orm.getMigrator().getExecutedMigrations(),
    ).toHaveLength(4);
  });

  test("unknown wallet is 404 and does not persist a transaction", async () => {
    const request = wager(randomUUID(), {
      externalTransactionId: "missing-wallet-wager",
    });
    const response = await submit(request);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "WALLET_NOT_FOUND",
      message: "Wallet not found.",
    });
    expect(
      await execute<{ id: string }[]>(
        "select id from wager_transactions where external_transaction_id = 'missing-wallet-wager'",
      ),
    ).toHaveLength(0);
  });

  test("submission validation rejects missing key, OPENING, malformed amounts and unknown fields", async () => {
    const wallet = await createWallet();
    const request = wager(wallet.id, { playerId: wallet.playerId });
    const noKeyResponse = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(noKeyResponse.status).toBe(400);
    expect(await noKeyResponse.json()).toMatchObject({
      code: "INVALID_TRANSACTION",
    });
    expect((await submit(wager(wallet.id, { kind: "OPENING" }))).status).toBe(
      400,
    );
    expect(
      (
        await submit({
          ...request,
          money: { amount: "1.001", currency: "BRL" },
        })
      ).status,
    ).toBe(400);
    expect((await submit({ ...request, extra: "unexpected" })).status).toBe(
      400,
    );
    expect(
      (await submit({ ...request, money: { amount: "1.00", currency: "ZZZ" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await submit({
          ...request,
          money: { amount: `${"9".repeat(37)}.00`, currency: "BRL" },
        })
      ).status,
    ).toBe(400);
  });

  test("internal and provider/external read routes return durable state only", async () => {
    const wallet = await createWallet();
    const externalTransactionId = "query-me";
    const result = await submit(
      wager(wallet.id, {
        playerId: wallet.playerId,
        externalTransactionId,
        kind: "LOSS",
      }),
    );
    const transactionId = (result.body as Submission).transactionId;
    const byId = await fetch(
      `${baseUrl}/wagering/transactions/${transactionId}`,
    );
    expect(byId.status).toBe(200);
    const idView = await byId.json();
    expect(idView).toMatchObject({
      transactionId,
      externalTransactionId,
      status: "PROCESSED",
      amount: "1.00",
      walletBalance: "0.00",
    });
    expect(idView).not.toHaveProperty("responseSnapshot");
    const byExternal = await fetch(
      `${baseUrl}/providers/provider-stage3/wagering/transactions/${externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(await byExternal.json()).toMatchObject({ transactionId });
    expect(
      (await fetch(`${baseUrl}/wagering/transactions/${randomUUID()}`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/providers/provider-stage3/wagering/transactions/missing`,
        )
      ).status,
    ).toBe(404);
  });

  test("50 simultaneous identical submissions cause one financial effect and return exact replays", async () => {
    const wallet = await createWallet("100.00");
    const request = wager(wallet.id, {
      playerId: wallet.playerId,
      externalTransactionId: "fifty-identical",
      amount: "3.00",
    });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(request, "fifty-identical-key")),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(50);
    expect(
      responses.filter(
        (response) => !(response.body as Submission).idempotentReplay,
      ),
    ).toHaveLength(1);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("97.00");
    expect((await wallets.get(wallet.id)).version).toBe(2);
    expect(await countForWallet("wager_transactions", wallet.id)).toBe(2);
    expect(await countForWallet("wallet_ledger_entries", wallet.id)).toBe(2);
    expect(await countForWallet("outbox_messages", wallet.id)).toBe(2);
  }, 30_000);

  test("two concurrent 80.00 BRL bets against 100.00 leave one success and one rejection", async () => {
    const wallet = await createWallet("100.00");
    const results = await Promise.all([
      submit(
        wager(wallet.id, {
          playerId: wallet.playerId,
          externalTransactionId: "race-bet-a",
          amount: "80.00",
        }),
        "race-key-a",
      ),
      submit(
        wager(wallet.id, {
          playerId: wallet.playerId,
          externalTransactionId: "race-bet-b",
          amount: "80.00",
        }),
        "race-key-b",
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("20.00");
    expect((await wallets.get(wallet.id)).version).toBe(2);
    expect(
      await execute<{ status: string; failure_code: string | null }[]>(
        `select status, failure_code from wager_transactions
       where kind = 'BET' and wallet_id = ? order by status`,
        [wallet.id],
      ),
    ).toEqual([
      { status: "PROCESSED", failure_code: null },
      { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
    ]);
    expect(
      await execute<{ direction: string; amount: string }[]>(
        `select direction, amount::text as amount from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT'`,
        [wallet.id],
      ),
    ).toEqual([{ direction: "DEBIT", amount: "80.00" }]);
  });

  test("concurrent direct reversals are serialized and only one changes the wallet", async () => {
    const wallet = await createWallet("100.00");
    const bet = await submit(
      wager(wallet.id, {
        playerId: wallet.playerId,
        externalTransactionId: "reversal-base-bet",
        amount: "20.00",
      }),
    );
    expect(bet.status).toBe(200);
    const reversal = (
      externalTransactionId: string,
      kind: "REFUND" | "ROLLBACK",
    ) =>
      submit(
        wager(wallet.id, {
          playerId: wallet.playerId,
          externalTransactionId,
          kind,
          amount: "20.00",
          referenceExternalTransactionId: "reversal-base-bet",
        }),
        `${externalTransactionId}-key`,
      );
    const results = await Promise.all([
      reversal("reversal-refund", "REFUND"),
      reversal("reversal-rollback", "ROLLBACK"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("100.00");
    expect(
      await execute<{ kind: string; status: string }[]>(
        `select kind, status from wager_transactions
       where status = 'PROCESSED'
         and reference_transaction_id = (
         select id from wager_transactions where external_transaction_id = 'reversal-base-bet'
       )`,
      ),
    ).toHaveLength(1);
  });

  test("outbox failure rolls back the transaction, wallet, ledger and response snapshot", async () => {
    const wallet = await createWallet("20.00");
    await execute(
      `create function fail_stage3_outbox() returns trigger language plpgsql as $$
       begin raise exception 'outbox injected failure'; end $$;
       create trigger stage3_outbox_failure before insert on outbox_messages
       for each row execute function fail_stage3_outbox()`,
    );
    try {
      const request = wager(wallet.id, {
        playerId: wallet.playerId,
        externalTransactionId: "outbox-rollback",
        amount: "4.00",
      });
      const failed = await submit(request, "outbox-rollback-key");
      expect(failed.status).toBe(503);
      expect(failed.body).toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("20.00");
      expect(
        await execute<{ id: string }[]>(
          "select id from wager_transactions where external_transaction_id = 'outbox-rollback'",
        ),
      ).toHaveLength(0);
      expect(await serviceLedgerCount(wallet.id)).toBe(1);
    } finally {
      await execute("drop trigger stage3_outbox_failure on outbox_messages");
      await execute("drop function fail_stage3_outbox()");
    }
  });

  test("transient serialization failures retry the whole transaction up to success", async () => {
    const wallet = await createWallet("20.00");
    await execute(
      `create sequence stage3_retry_sequence;
       create function fail_stage3_outbox_twice() returns trigger language plpgsql as $$
       begin
         if nextval('stage3_retry_sequence') < 3 then
           raise exception 'injected serialization failure' using errcode = '40001';
         end if;
         return new;
       end $$;
       create trigger stage3_retry_failure before insert on outbox_messages
       for each row execute function fail_stage3_outbox_twice()`,
    );
    try {
      const response = await submit(
        wager(wallet.id, {
          playerId: wallet.playerId,
          externalTransactionId: "retry-success",
          amount: "4.00",
        }),
        "retry-success-key",
      );
      expect(response.status).toBe(200);
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("16.00");
      expect(
        await execute<{ attempts: string }[]>(
          "select last_value::text as attempts from stage3_retry_sequence",
        ),
      ).toEqual([{ attempts: "4" }]);
      expect(await countForWallet("wager_transactions", wallet.id)).toBe(2);
      expect(await countForWallet("wallet_ledger_entries", wallet.id)).toBe(2);
    } finally {
      await execute("drop trigger stage3_retry_failure on outbox_messages");
      await execute("drop function fail_stage3_outbox_twice()");
      await execute("drop sequence stage3_retry_sequence");
    }
  });
});
