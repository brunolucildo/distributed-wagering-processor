import {
  DomainError,
  DomainFailureCode,
} from "../../../wallets/domain/errors/domain-error";
import { Money } from "../../../wallets/domain/value-objects/money";

export type LedgerDirection = "CREDIT" | "DEBIT";

export interface CreateWalletLedgerEntry {
  id: string;
  walletId: string;
  transactionId: string;
  amount: Money;
  direction: LedgerDirection;
  balanceBefore: Money;
  balanceAfter: Money;
  occurredAt: string | Date;
}

export interface WalletLedgerEntrySnapshot {
  id: string;
  walletId: string;
  transactionId: string;
  amount: string;
  currency: string;
  direction: LedgerDirection;
  balanceBefore: string;
  balanceAfter: string;
  occurredAt: string;
}

function asIsoTimestamp(value: string | Date): string {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError(
      DomainFailureCode.INVALID_TRANSACTION,
      "Ledger timestamp must be a valid instant.",
    );
  }
  return date.toISOString();
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly amount: Money,
    public readonly direction: LedgerDirection,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly occurredAt: string,
  ) {
    Object.freeze(this);
  }

  static create(input: CreateWalletLedgerEntry): WalletLedgerEntry {
    if (
      !input.id.trim() ||
      !input.walletId.trim() ||
      !input.transactionId.trim() ||
      !input.amount.isPositive()
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Ledger identity and amount must be valid.",
      );
    }

    if (
      input.amount.currency !== input.balanceBefore.currency ||
      input.amount.currency !== input.balanceAfter.currency
    ) {
      throw new DomainError(
        DomainFailureCode.CURRENCY_MISMATCH,
        "Ledger amount and balances must use the same currency.",
      );
    }

    const expectedAfter =
      input.direction === "CREDIT"
        ? input.balanceBefore.add(input.amount)
        : input.direction === "DEBIT"
          ? input.balanceBefore.subtract(input.amount)
          : null;

    if (
      expectedAfter === null ||
      input.balanceBefore.isNegative() ||
      input.balanceAfter.isNegative() ||
      !expectedAfter.equals(input.balanceAfter)
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Ledger entry does not satisfy its balance equation.",
      );
    }

    return new WalletLedgerEntry(
      input.id,
      input.walletId,
      input.transactionId,
      input.amount,
      input.direction,
      input.balanceBefore,
      input.balanceAfter,
      asIsoTimestamp(input.occurredAt),
    );
  }

  static rehydrate(snapshot: WalletLedgerEntrySnapshot): WalletLedgerEntry {
    return new WalletLedgerEntry(
      snapshot.id,
      snapshot.walletId,
      snapshot.transactionId,
      Money.rehydrate(snapshot.amount, snapshot.currency),
      snapshot.direction,
      Money.rehydrate(snapshot.balanceBefore, snapshot.currency),
      Money.rehydrate(snapshot.balanceAfter, snapshot.currency),
      snapshot.occurredAt,
    );
  }
}
