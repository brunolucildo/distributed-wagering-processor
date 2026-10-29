import { describe, expect, test } from "bun:test";
import {
  DomainError,
  DomainFailureCode,
} from "../../../src/modules/wallets/domain/errors/domain-error";
import { Wallet } from "../../../src/modules/wallets/domain/entities/wallet";
import { WalletLedgerEntry } from "../../../src/modules/ledger/domain/entities/wallet-ledger-entry";
import {
  WagerTransaction,
  type ExternalWagerKind,
} from "../../../src/modules/wagering/domain/entities/wager-transaction";
import { ProcessWager } from "../../../src/modules/wagering/domain/services/process-wager";
import { Money } from "../../../src/modules/wallets/domain/value-objects/money";

const now = "2026-10-29T12:00:00.000Z";

function money(amount: string, currency = "BRL"): Money {
  return Money.parse(amount, currency);
}

function openWallet(balance = "100.00", currency = "BRL"): Wallet {
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
  const currency = overrides.currency ?? "BRL";
  return WagerTransaction.create({
    id,
    providerId: overrides.providerId ?? "provider-1",
    externalTransactionId: id,
    playerId: overrides.playerId ?? "player-1",
    walletId: overrides.walletId ?? "wallet-1",
    currency,
    roundId: overrides.roundId ?? "round-1",
    kind,
    amount: money(amount, currency),
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
    createdAt: now,
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

function apply(
  wager: WagerTransaction,
  wallet: Wallet | undefined,
  options: {
    reference?:
      | { status: "not-found" }
      | { status: "found"; transaction: WagerTransaction };
    referenceAlreadyReversed?: boolean;
    ledgerEntryId?: string;
  } = {},
) {
  return ProcessWager.apply(wager, wallet, {
    ...(options.reference === undefined
      ? {}
      : { reference: options.reference }),
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    occurredAt: now,
    ledgerEntryId: options.ledgerEntryId ?? `${wager.id}-ledger`,
  });
}

describe("Money and rehydration edge cases", () => {
  test("preserves cent precision across a large carry and negative rehydration", () => {
    const large = money("9007199254740993.99");
    const carried = large.add(money("0.01"));
    const restoredNegative = Money.rehydrate(
      carried.negate().toString(),
      "BRL",
    );

    expect(carried.toString()).toBe("9007199254740994.00");
    expect(carried.subtract(money("9007199254740993.99")).toString()).toBe(
      "0.01",
    );
    expect(restoredNegative.toString()).toBe("-9007199254740994.00");
    expect(restoredNegative.add(carried).toString()).toBe("0.00");
  });

  test("rehydrates wallet balance and version without reopening it", () => {
    const restored = Wallet.rehydrate({
      id: "wallet-restored",
      playerId: "player-1",
      currency: "BRL",
      balance: "12345678901234567890.07",
      version: 14,
    });

    expect(restored.balance.toString()).toBe("12345678901234567890.07");
    expect(restored.version).toBe(14);
    expect(Object.isFrozen(restored)).toBe(true);
  });
});

describe("Wager lifecycle edge transitions", () => {
  test("allows FAILED only with the permanent transaction-specific code", () => {
    const pending = transaction("BET", "failed-pending");
    const pendingReference = transaction(
      "WIN",
      "failed-reference",
      "10.00",
      "bet-not-yet-available",
    );

    expect(() =>
      pending.transition("FAILED", {
        failureCode: DomainFailureCode.INSUFFICIENT_FUNDS,
        occurredAt: now,
      }),
    ).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
    expect(() =>
      pendingReference.transition("FAILED", {
        failureCode: DomainFailureCode.PERMANENT_PROCESSING_FAILURE,
        occurredAt: now,
      }),
    ).not.toThrow();

    const failed = pending.transition("FAILED", {
      failureCode: DomainFailureCode.PERMANENT_PROCESSING_FAILURE,
      occurredAt: now,
    });
    expect(() => failed.transition("PROCESSED")).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
  });

  test("requires a failure code for rejection and permits pending-reference resolution", () => {
    const pending = transaction("BET", "rejection-needs-code");
    const waiting = transaction(
      "WIN",
      "waiting-for-reference",
      "3.00",
      "bet-later",
    );

    expect(() => pending.transition("REJECTED", { occurredAt: now })).toThrow(
      expect.objectContaining({
        code: DomainFailureCode.INVALID_STATE_TRANSITION,
      }),
    );
    expect(pending.transition("PENDING_REFERENCE").status).toBe(
      "PENDING_REFERENCE",
    );
    expect(waiting.transition("PROCESSED", { occurredAt: now }).status).toBe(
      "PROCESSED",
    );
    expect(() =>
      waiting.transition("REJECTED", {
        failureCode: DomainFailureCode.REFERENCE_NOT_FOUND,
        occurredAt: now,
      }),
    ).not.toThrow();
  });
});

describe("Reversal uniqueness precondition", () => {
  test("does not apply a reversal when the uniqueness check is omitted", () => {
    const bet = processedReference("BET", "uniqueness-bet", "10.00");
    const refund = transaction(
      "REFUND",
      "uniqueness-refund",
      "10.00",
      "uniqueness-bet",
    );
    const options = {
      reference: { status: "found" as const, transaction: bet },
      occurredAt: now,
      ledgerEntryId: "uniqueness-refund-ledger",
    };

    expect(() =>
      Reflect.apply(ProcessWager.apply, ProcessWager, [
        refund,
        openWallet(),
        options,
      ]),
    ).toThrow("Reversal processing requires a reference uniqueness check.");
  });
});

describe("Ledger balance equation edges", () => {
  test.each([
    ["CREDIT", "0.00", "0.01", "0.01"],
    ["DEBIT", "0.01", "0.01", "0.00"],
  ] as const)(
    "accepts a %s equation at the zero-balance boundary",
    (direction, before, amount, after) => {
      expect(
        WalletLedgerEntry.create({
          id: `entry-${direction}`,
          walletId: "wallet-1",
          transactionId: `transaction-${direction}`,
          amount: money(amount),
          direction,
          balanceBefore: money(before),
          balanceAfter: money(after),
          occurredAt: now,
        }).balanceAfter.toString(),
      ).toBe(after);
    },
  );

  test.each([
    ["CREDIT", "1.00", "0.99"],
    ["DEBIT", "0.00", "0.01"],
  ] as const)(
    "rejects a %s entry that violates the balance equation",
    (direction, before, after) => {
      expect(() =>
        WalletLedgerEntry.create({
          id: `invalid-${direction}`,
          walletId: "wallet-1",
          transactionId: `invalid-transaction-${direction}`,
          amount: money("0.01"),
          direction,
          balanceBefore: money(before),
          balanceAfter: money(after),
          occurredAt: now,
        }),
      ).toThrow(DomainError);
    },
  );

  test("rejects ledger entries whose balances use a different currency", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "cross-currency-entry",
        walletId: "wallet-1",
        transactionId: "cross-currency-transaction",
        amount: money("1.00", "BRL"),
        direction: "CREDIT",
        balanceBefore: money("0.00", "BRL"),
        balanceAfter: money("1.00", "USD"),
        occurredAt: now,
      }),
    ).toThrow(
      expect.objectContaining({ code: DomainFailureCode.CURRENCY_MISMATCH }),
    );
  });
});

describe("Operation, reference, and reversal edge cases", () => {
  test("leaves a WIN waiting when its supplied reference is unresolved", () => {
    const wallet = openWallet();
    const win = transaction("WIN", "win-waiting", "4.00", "bet-later");
    const result = apply(win, wallet, {
      reference: { status: "not-found" },
    });

    expect(result.transaction.status).toBe("PENDING_REFERENCE");
    expect(result.ledgerEntry).toBeNull();
    expect(result.wallet).toBe(wallet);
    expect(result.wallet?.version).toBe(1);
  });

  test("requires a supplied WIN reference to be a processed BET", () => {
    const wallet = openWallet();
    const loss = processedReference("LOSS", "loss-for-win", "4.00");
    const win = transaction("WIN", "win-wrong-reference", "4.00", loss.id);
    const result = apply(win, wallet, {
      reference: { status: "found", transaction: loss },
    });

    expect(result.transaction.failureCode).toBe(
      DomainFailureCode.REFERENCE_INVALID,
    );
    expect(result.ledgerEntry).toBeNull();
    expect(result.wallet).toBe(wallet);
  });

  test("rolls back a WIN with a debit entry and preserves the ledger equation", () => {
    const wallet = openWallet("20.00");
    const win = processedReference("WIN", "win-to-rollback", "7.25");
    const rollback = transaction(
      "ROLLBACK",
      "rollback-win",
      "7.25",
      win.externalTransactionId ?? undefined,
    );
    const result = apply(rollback, wallet, {
      reference: { status: "found", transaction: win },
    });

    expect(result.transaction.status).toBe("PROCESSED");
    expect(result.ledgerEntry?.direction).toBe("DEBIT");
    expect(result.ledgerEntry?.balanceBefore.toString()).toBe("20.00");
    expect(result.ledgerEntry?.balanceAfter.toString()).toBe("12.75");
    expect(
      result.ledgerEntry?.balanceBefore
        .subtract(result.ledgerEntry.amount)
        .equals(result.ledgerEntry.balanceAfter),
    ).toBe(true);
  });

  test("rolling back a refund does not make its original BET eligible for another refund", () => {
    const wallet = openWallet("90.00");
    const bet = processedReference("BET", "bet-refunded", "10.00");
    const refund = transaction("REFUND", "refund-once", "10.00", bet.id);
    const refunded = apply(refund, wallet, {
      reference: { status: "found", transaction: bet },
    });
    const rollbackRefund = transaction(
      "ROLLBACK",
      "rollback-refund-once",
      "10.00",
      refund.id,
    );
    const rolledBack = apply(rollbackRefund, refunded.wallet, {
      reference: { status: "found", transaction: refunded.transaction },
    });
    const secondRefund = transaction("REFUND", "refund-again", "10.00", bet.id);
    const duplicate = apply(secondRefund, rolledBack.wallet, {
      reference: { status: "found", transaction: bet },
      referenceAlreadyReversed: true,
    });

    expect(refunded.wallet?.balance.toString()).toBe("100.00");
    expect(rolledBack.ledgerEntry?.direction).toBe("DEBIT");
    expect(rolledBack.wallet?.balance.toString()).toBe("90.00");
    expect(duplicate.transaction.failureCode).toBe(
      DomainFailureCode.REFERENCE_ALREADY_REVERSED,
    );
    expect(duplicate.ledgerEntry).toBeNull();
    expect(duplicate.wallet?.balance.toString()).toBe("90.00");
  });

  test("keeps the wallet balance equal to opening balance plus signed ledger entries", () => {
    const opening = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      openingBalance: money("100.00"),
      openingTransactionId: "opening-equation",
      openingLedgerEntryId: "opening-equation-ledger",
      openedAt: now,
    });
    let wallet = opening.wallet;
    const entries: WalletLedgerEntry[] = [];
    if (opening.ledgerEntry) entries.push(opening.ledgerEntry);

    const bet = transaction("BET", "equation-bet", "12.00");
    const afterBet = apply(bet, wallet);
    wallet = afterBet.wallet as Wallet;
    if (afterBet.ledgerEntry) entries.push(afterBet.ledgerEntry);

    const win = transaction("WIN", "equation-win", "3.00");
    const afterWin = apply(win, wallet);
    wallet = afterWin.wallet as Wallet;
    if (afterWin.ledgerEntry) entries.push(afterWin.ledgerEntry);

    const loss = transaction("LOSS", "equation-loss", "2.00");
    const afterLoss = apply(loss, wallet);
    wallet = afterLoss.wallet as Wallet;
    if (afterLoss.ledgerEntry) entries.push(afterLoss.ledgerEntry);

    const refund = transaction("REFUND", "equation-refund", "12.00", bet.id);
    const afterRefund = apply(refund, wallet, {
      reference: {
        status: "found",
        transaction: bet.transition("PROCESSED", {
          occurredAt: now,
        }),
      },
    });
    wallet = afterRefund.wallet as Wallet;
    if (afterRefund.ledgerEntry) entries.push(afterRefund.ledgerEntry);

    const rollbackWin = transaction(
      "ROLLBACK",
      "equation-rollback-win",
      "3.00",
      win.id,
    );
    const afterRollbackWin = apply(rollbackWin, wallet, {
      reference: {
        status: "found",
        transaction: win.transition("PROCESSED", {
          occurredAt: now,
        }),
      },
    });
    wallet = afterRollbackWin.wallet as Wallet;
    if (afterRollbackWin.ledgerEntry)
      entries.push(afterRollbackWin.ledgerEntry);

    const signedChanges = entries
      .slice(1)
      .reduce(
        (sum, entry) =>
          sum.add(
            entry.direction === "CREDIT" ? entry.amount : entry.amount.negate(),
          ),
        Money.zero("BRL"),
      );
    const computedBalance = opening.wallet.balance.add(signedChanges);

    expect(afterLoss.ledgerEntry).toBeNull();
    expect(wallet.version).toBe(5);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(computedBalance.equals(wallet.balance)).toBe(true);
    for (const entry of entries) {
      const expectedAfter =
        entry.direction === "CREDIT"
          ? entry.balanceBefore.add(entry.amount)
          : entry.balanceBefore.subtract(entry.amount);
      expect(expectedAfter.equals(entry.balanceAfter)).toBe(true);
    }
  });
});
