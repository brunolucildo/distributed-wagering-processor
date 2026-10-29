import { describe, expect, test } from "bun:test";
import {
  DomainError,
  DomainFailureCode,
} from "../../../src/modules/wallets/domain/errors/domain-error";
import { Money } from "../../../src/modules/wallets/domain/value-objects/money";
import { Wallet } from "../../../src/modules/wallets/domain/entities/wallet";
import { WalletLedgerEntry } from "../../../src/modules/ledger/domain/entities/wallet-ledger-entry";
import {
  WagerTransaction,
  type ExternalWagerKind,
} from "../../../src/modules/wagering/domain/entities/wager-transaction";
import { ProcessWager } from "../../../src/modules/wagering/domain/services/process-wager";
import type { WagerProcessedIntegrationEvent } from "../../../src/modules/messaging/contracts/integration-events";

const now = "2026-10-29T12:00:00.000Z";

function money(amount: string, currency = "BRL"): Money {
  return Money.parse(amount, currency);
}

function openWallet(balance = "100.00", currency = "BRL") {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    currency,
    openingBalance: money(balance, currency),
    openingTransactionId: "opening-1",
    openingLedgerEntryId: "opening-ledger-1",
    openedAt: now,
  }).wallet;
}

function transaction(
  kind: ExternalWagerKind,
  id: string,
  amount = "10.00",
  referenceExternalTransactionId?: string,
  overrides: Partial<{
    playerId: string;
    walletId: string;
    providerId: string;
    roundId: string;
    currency: string;
  }> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: overrides.providerId ?? "provider-1",
    externalTransactionId: id,
    playerId: overrides.playerId ?? "player-1",
    walletId: overrides.walletId ?? "wallet-1",
    currency: overrides.currency ?? "BRL",
    roundId: overrides.roundId ?? "round-1",
    kind,
    amount: money(amount, overrides.currency ?? "BRL"),
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
    createdAt: now,
  });
}

function apply(
  tx: WagerTransaction,
  wallet: Wallet | undefined,
  options: {
    reference?:
      | {
          status: "not-found";
        }
      | {
          status: "found";
          transaction: WagerTransaction;
        };
    referenceAlreadyReversed?: boolean;
    ledgerEntryId?: string;
  } = {},
) {
  return ProcessWager.apply(tx, wallet, {
    ...(options.reference === undefined
      ? {}
      : { reference: options.reference }),
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    occurredAt: now,
    ledgerEntryId: options.ledgerEntryId ?? `${tx.id}-ledger`,
  });
}

function processedReference(
  kind: ExternalWagerKind,
  id: string,
  amount: string,
): WagerTransaction {
  return transaction(kind, id, amount).transition("PROCESSED", {
    occurredAt: now,
  });
}

describe("Money", () => {
  test("parses and calculates exact amounts with arbitrary-size integer cents", () => {
    const large = money("90071992547409931234567890.11");
    const increment = money("0.09");

    expect(large.add(increment).toString()).toBe(
      "90071992547409931234567890.20",
    );
    expect(money("0.30").subtract(money("0.10")).toString()).toBe("0.20");
    expect(money("3.25").negate().toString()).toBe("-3.25");
    expect(JSON.stringify(money("12.34"))).toBe('"12.34"');
    expect(Object.isFrozen(money("1.00"))).toBe(true);
  });

  test.each([
    "",
    " ",
    "1",
    "1.0",
    "1.000",
    "-1.00",
    "+1.00",
    "1e2",
    "NaN",
    "Infinity",
    " 1.00",
    "1.00 ",
  ])("rejects invalid external amount %j", (amount) => {
    expect(() => money(amount)).toThrow(DomainError);
  });

  test.each(["brl", "US", "ZZZ", "BR1"])(
    "rejects a non-ISO currency code %s",
    (currency) => {
      expect(() => money("1.00", currency)).toThrow(DomainError);
    },
  );

  test("rejects cross-currency operations", () => {
    expect(() => money("1.00", "BRL").add(money("1.00", "USD"))).toThrow(
      expect.objectContaining({ code: DomainFailureCode.CURRENCY_MISMATCH }),
    );
  });
});

describe("Wallet and ledger", () => {
  test("opens at version one and only records positive openings", () => {
    const zero = Wallet.open({
      id: "wallet-zero",
      playerId: "player-1",
      currency: "BRL",
      openingBalance: money("0.00"),
      openedAt: now,
    });
    const positive = Wallet.open({
      id: "wallet-positive",
      playerId: "player-1",
      currency: "BRL",
      openingBalance: money("2.50"),
      openingTransactionId: "positive-opening",
      openingLedgerEntryId: "positive-ledger",
      openedAt: now,
    });

    expect(zero.wallet.version).toBe(1);
    expect(zero.openingTransaction).toBeNull();
    expect(zero.ledgerEntry).toBeNull();
    expect(positive.wallet.version).toBe(1);
    expect(positive.openingTransaction?.kind).toBe("OPENING");
    expect(positive.openingTransaction?.status).toBe("PROCESSED");
    expect(positive.ledgerEntry?.balanceBefore.toString()).toBe("0.00");
    expect(positive.ledgerEntry?.balanceAfter.toString()).toBe("2.50");
  });

  test("increments wallet version once per balance change", () => {
    const wallet = openWallet();
    const debit = wallet.debit(money("10.00"));
    const credit = debit.wallet.credit(money("3.00"));

    expect(wallet.balance.toString()).toBe("100.00");
    expect(debit.wallet.balance.toString()).toBe("90.00");
    expect(debit.wallet.version).toBe(2);
    expect(credit.wallet.balance.toString()).toBe("93.00");
    expect(credit.wallet.version).toBe(3);
    expect(() => wallet.debit(money("100.01"))).toThrow(
      expect.objectContaining({ code: DomainFailureCode.INSUFFICIENT_FUNDS }),
    );
  });

  test("validates the immutable ledger balance equation", () => {
    const valid = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      amount: money("5.00"),
      direction: "DEBIT",
      balanceBefore: money("10.00"),
      balanceAfter: money("5.00"),
      occurredAt: now,
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-2",
        walletId: "wallet-1",
        transactionId: "transaction-2",
        amount: money("5.00"),
        direction: "DEBIT",
        balanceBefore: money("10.00"),
        balanceAfter: money("6.00"),
        occurredAt: now,
      }),
    ).toThrow(DomainError);
  });
});

describe("WagerTransaction lifecycle", () => {
  test("creates pending and pending-reference transactions and allows only specified transitions", () => {
    const pending = transaction("BET", "bet-1");
    const pendingReference = transaction(
      "REFUND",
      "refund-1",
      "10.00",
      "bet-1",
    );
    expect(pending.status).toBe("PENDING");
    expect(pendingReference.status).toBe("PENDING_REFERENCE");
    expect(pending.transition("PROCESSED", { occurredAt: now }).status).toBe(
      "PROCESSED",
    );
    expect(() => pending.transition("PENDING")).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
    expect(() => pendingReference.transition("PENDING")).toThrow(DomainError);
  });

  test("rejects missing required references and external OPENING operations", () => {
    expect(() => transaction("REFUND", "refund-1", "10.00")).toThrow(
      DomainError,
    );
    expect(() =>
      WagerTransaction.create({
        id: "opening",
        providerId: "provider-1",
        externalTransactionId: "opening",
        playerId: "player-1",
        walletId: "wallet-1",
        currency: "BRL",
        roundId: "round-1",
        kind: "OPENING" as ExternalWagerKind,
        amount: money("1.00"),
        createdAt: now,
      }),
    ).toThrow(DomainError);
  });

  test("rehydrates terminal snapshots without replaying lifecycle validation", () => {
    const restored = WagerTransaction.rehydrate({
      id: "replayed",
      providerId: "provider-1",
      externalTransactionId: "external-1",
      playerId: "player-1",
      walletId: "wallet-1",
      currency: "BRL",
      roundId: "round-1",
      kind: "BET",
      status: "REJECTED",
      amount: "1.00",
      referenceExternalTransactionId: null,
      failureCode: DomainFailureCode.INSUFFICIENT_FUNDS,
      createdAt: now,
      completedAt: now,
    });

    expect(restored.status).toBe("REJECTED");
    expect(restored.amount.toString()).toBe("1.00");
    expect(() => restored.transition("PROCESSED")).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
  });

  test("terminal states are immutable", () => {
    const processed = processedReference("BET", "bet-1", "10.00");
    expect(() =>
      processed.transition("REJECTED", {
        failureCode: DomainFailureCode.INVALID_TRANSACTION,
      }),
    ).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
  });
});

describe("wager processing rules", () => {
  test.each([
    ["BET", "10.00", "DEBIT", "90.00"],
    ["WIN", "10.00", "CREDIT", "110.00"],
    ["REFUND", "10.00", "CREDIT", "110.00"],
    ["ROLLBACK", "10.00", "CREDIT", "110.00"],
  ] as const)(
    "applies %s with a consistent ledger entry",
    (kind, amount, direction, expectedBalance) => {
      const wallet = openWallet();
      let ref: WagerTransaction | undefined;
      let tx: WagerTransaction;
      if (kind === "REFUND" || kind === "ROLLBACK") {
        ref = processedReference("BET", "bet-reference", amount);
        tx = transaction(
          kind,
          `${kind.toLowerCase()}-1`,
          amount,
          "bet-reference",
        );
      } else {
        tx = transaction(kind, `${kind.toLowerCase()}-1`, amount);
      }

      const result = apply(tx, wallet, {
        ...(ref === undefined
          ? {}
          : { reference: { status: "found" as const, transaction: ref } }),
      });
      const entry = result.ledgerEntry;

      expect(result.transaction.status).toBe("PROCESSED");
      expect(entry?.direction).toBe(direction);
      expect(entry?.balanceAfter.toString()).toBe(expectedBalance);
      expect(
        direction === "CREDIT"
          ? entry?.balanceBefore.add(entry.amount).equals(entry.balanceAfter)
          : entry?.balanceBefore
              .subtract(entry.amount)
              .equals(entry.balanceAfter),
      ).toBe(true);
      expect(result.wallet?.balance.toString()).toBe(expectedBalance);
      expect(result.wallet?.version).toBe(2);
    },
  );

  test("records LOSS without a ledger or wallet version change", () => {
    const wallet = openWallet();
    const result = apply(transaction("LOSS", "loss-1"), wallet);

    expect(result.transaction.status).toBe("PROCESSED");
    expect(result.ledgerEntry).toBeNull();
    expect(result.wallet).toBe(wallet);
    expect(result.wallet?.version).toBe(1);
  });

  test("rejects BET with insufficient funds and distinguishes reversal overdraw", () => {
    const wallet = openWallet("10.00");
    const bet = apply(transaction("BET", "bet-too-large", "11.00"), wallet);
    expect(bet.transaction.failureCode).toBe(
      DomainFailureCode.INSUFFICIENT_FUNDS,
    );
    expect(bet.ledgerEntry).toBeNull();
    expect(bet.wallet?.balance.toString()).toBe("10.00");

    const winReference = processedReference("WIN", "win-large", "11.00");
    const rollback = transaction(
      "ROLLBACK",
      "rollback-large",
      "11.00",
      "win-large",
    );
    const reversal = apply(rollback, wallet, {
      reference: { status: "found", transaction: winReference },
    });
    expect(reversal.transaction.failureCode).toBe(
      DomainFailureCode.REVERSAL_WOULD_OVERDRAW,
    );
    expect(reversal.ledgerEntry).toBeNull();
  });

  test("stores unresolved references and can reject them when they expire", () => {
    const wallet = openWallet();
    const refund = transaction("REFUND", "refund-pending", "10.00", "not-yet");
    const pending = apply(refund, wallet, {
      reference: { status: "not-found" },
    });
    expect(pending.transaction.status).toBe("PENDING_REFERENCE");
    expect(pending.ledgerEntry).toBeNull();

    const expired = ProcessWager.expireReference(
      pending.transaction,
      wallet,
      now,
    );
    expect(expired.transaction.status).toBe("REJECTED");
    expect(expired.transaction.failureCode).toBe(
      DomainFailureCode.REFERENCE_NOT_FOUND,
    );
    expect(expired.wallet).toBe(wallet);
  });

  test("validates reference identity, kind, amount, and direct-reversal uniqueness", () => {
    const wallet = openWallet();
    const bet = processedReference("BET", "bet-original", "10.00");
    const wrongPlayer = transaction(
      "REFUND",
      "refund-wrong-player",
      "10.00",
      "bet-original",
      { playerId: "player-other" },
    );
    expect(
      apply(wrongPlayer, wallet, {
        reference: { status: "found", transaction: bet },
      }).transaction.failureCode,
    ).toBe(DomainFailureCode.WALLET_MISMATCH);

    const mismatchedAmount = transaction(
      "REFUND",
      "refund-mismatch",
      "9.99",
      "bet-original",
    );
    expect(
      apply(mismatchedAmount, wallet, {
        reference: { status: "found", transaction: bet },
      }).transaction.failureCode,
    ).toBe(DomainFailureCode.REVERSAL_AMOUNT_MISMATCH);

    const duplicateRefund = transaction(
      "ROLLBACK",
      "rollback-duplicate",
      "10.00",
      "bet-original",
    );
    expect(
      apply(duplicateRefund, wallet, {
        reference: { status: "found", transaction: bet },
        referenceAlreadyReversed: true,
      }).transaction.failureCode,
    ).toBe(DomainFailureCode.REFERENCE_ALREADY_REVERSED);

    const wrongKindReference = processedReference("LOSS", "loss-ref", "10.00");
    const rollbackLoss = transaction(
      "ROLLBACK",
      "rollback-loss",
      "10.00",
      "loss-ref",
    );
    expect(
      apply(rollbackLoss, wallet, {
        reference: { status: "found", transaction: wrongKindReference },
      }).transaction.failureCode,
    ).toBe(DomainFailureCode.REFERENCE_INVALID);
  });

  test.each([
    [
      "providerId",
      { providerId: "provider-other" },
      DomainFailureCode.REFERENCE_INVALID,
    ],
    [
      "playerId",
      { playerId: "player-other" },
      DomainFailureCode.WALLET_MISMATCH,
    ],
    [
      "walletId",
      { walletId: "wallet-other" },
      DomainFailureCode.WALLET_MISMATCH,
    ],
    [
      "roundId",
      { roundId: "round-other" },
      DomainFailureCode.REFERENCE_INVALID,
    ],
    ["currency", { currency: "USD" }, DomainFailureCode.CURRENCY_MISMATCH],
  ] as const)(
    "rejects a referenced operation with different %s",
    (_field, overrides, expectedCode) => {
      const wallet = openWallet();
      const reference = transaction(
        "BET",
        "identity-reference",
        "10.00",
        undefined,
        overrides,
      ).transition("PROCESSED", { occurredAt: now });
      const refund = transaction(
        "REFUND",
        `identity-refund-${_field}`,
        "10.00",
        "identity-reference",
      );

      expect(
        apply(refund, wallet, {
          reference: { status: "found", transaction: reference },
        }).transaction.failureCode,
      ).toBe(expectedCode);
    },
  );

  test("rollback of a refund reverses only that refund", () => {
    const wallet = openWallet("90.00");
    const bet = processedReference("BET", "bet-1", "10.00");
    const refund = transaction("REFUND", "refund-1", "10.00", "bet-1");
    const refunded = apply(refund, wallet, {
      reference: { status: "found", transaction: bet },
    });

    expect(refunded.wallet?.balance.toString()).toBe("100.00");

    const rollbackRefund = transaction(
      "ROLLBACK",
      "rollback-refund",
      "10.00",
      "refund-1",
    );
    const rolledBack = apply(rollbackRefund, refunded.wallet, {
      reference: {
        status: "found",
        transaction: refunded.transaction,
      },
    });
    expect(rolledBack.ledgerEntry?.direction).toBe("DEBIT");
    expect(rolledBack.wallet?.balance.toString()).toBe("90.00");
  });

  test("validates the supplied WIN reference but does not require the BET amount to equal the WIN", () => {
    const wallet = openWallet();
    const bet = processedReference("BET", "bet-for-win", "25.00");
    const win = transaction("WIN", "win-1", "40.00", "bet-for-win");
    const result = apply(win, wallet, {
      reference: { status: "found", transaction: bet },
    });
    expect(result.transaction.status).toBe("PROCESSED");
    expect(result.wallet?.balance.toString()).toBe("140.00");
  });

  test("rejects unknown wallet, wallet mismatch, and currency mismatch", () => {
    const bet = transaction("BET", "wallet-test");
    expect(apply(bet, undefined).transaction.failureCode).toBe(
      DomainFailureCode.WALLET_NOT_FOUND,
    );
    expect(
      apply(
        transaction("BET", "other-wallet", "1.00", undefined, {
          walletId: "wallet-other",
        }),
        openWallet(),
      ).transaction.failureCode,
    ).toBe(DomainFailureCode.WALLET_MISMATCH);
    expect(
      apply(
        transaction("BET", "other-currency", "1.00", undefined, {
          currency: "USD",
        }),
        openWallet("100.00", "BRL"),
      ).transaction.failureCode,
    ).toBe(DomainFailureCode.CURRENCY_MISMATCH);
  });
});

describe("integration event contracts", () => {
  test("represent monetary values as JSON-safe decimal strings", () => {
    const event: WagerProcessedIntegrationEvent = {
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      version: 1,
      aggregateId: "tx-1",
      correlationId: "correlation-1",
      occurredAt: now,
      data: {
        transactionId: "tx-1",
        providerId: "provider-1",
        externalTransactionId: "external-1",
        playerId: "player-1",
        walletId: "wallet-1",
        roundId: "round-1",
        kind: "BET",
        amount: money("5.25").toString(),
        currency: "BRL",
        walletBalance: money("94.75").toString(),
        ledgerEntryId: "ledger-1",
      },
    };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    expect(typeof event.data.amount).toBe("string");
    expect(event.data.amount).toBe("5.25");
  });
});
