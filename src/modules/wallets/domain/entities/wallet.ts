import { WalletLedgerEntry } from "../../../ledger/domain/entities/wallet-ledger-entry";
import { WagerTransaction } from "../../../wagering/domain/entities/wager-transaction";
import { DomainError, DomainFailureCode } from "../errors/domain-error";
import { Money } from "../value-objects/money";

export interface OpenWalletInput {
  id: string;
  playerId: string;
  currency: string;
  openingBalance: Money;
  openingTransactionId?: string;
  openingLedgerEntryId?: string;
  openedAt: string | Date;
}

export interface WalletBalanceChange {
  wallet: Wallet;
  balanceBefore: Money;
  balanceAfter: Money;
  direction: "CREDIT" | "DEBIT";
}

export interface WalletOpening {
  wallet: Wallet;
  openingTransaction: WagerTransaction | null;
  ledgerEntry: WalletLedgerEntry | null;
}

export interface WalletSnapshot {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    public readonly balance: Money,
    public readonly version: number,
  ) {
    Object.freeze(this);
  }

  static open(input: OpenWalletInput): WalletOpening {
    if (!input.id.trim() || !input.playerId.trim()) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Wallet and player identifiers are required.",
      );
    }
    if (input.openingBalance.currency !== input.currency) {
      throw new DomainError(
        DomainFailureCode.CURRENCY_MISMATCH,
        "Opening balance currency must match wallet currency.",
      );
    }
    if (input.openingBalance.isNegative()) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Wallet opening balance cannot be negative.",
      );
    }

    const wallet = new Wallet(
      input.id,
      input.playerId,
      input.currency,
      input.openingBalance,
      1,
    );
    if (input.openingBalance.isZero()) {
      return { wallet, openingTransaction: null, ledgerEntry: null };
    }
    if (!input.openingTransactionId || !input.openingLedgerEntryId) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "A positive wallet opening requires transaction and ledger identities.",
      );
    }

    const openingTransaction = WagerTransaction.opening({
      id: input.openingTransactionId,
      walletId: input.id,
      playerId: input.playerId,
      amount: input.openingBalance,
      occurredAt: input.openedAt,
    });
    const ledgerEntry = WalletLedgerEntry.create({
      id: input.openingLedgerEntryId,
      walletId: input.id,
      transactionId: openingTransaction.id,
      amount: input.openingBalance,
      direction: "CREDIT",
      balanceBefore: Money.zero(input.currency),
      balanceAfter: input.openingBalance,
      occurredAt: input.openedAt,
    });
    return { wallet, openingTransaction, ledgerEntry };
  }

  static rehydrate(snapshot: WalletSnapshot): Wallet {
    return new Wallet(
      snapshot.id,
      snapshot.playerId,
      snapshot.currency,
      Money.rehydrate(snapshot.balance, snapshot.currency),
      snapshot.version,
    );
  }

  credit(amount: Money): WalletBalanceChange {
    this.assertOperationAmount(amount);
    const balanceAfter = this.balance.add(amount);
    return {
      wallet: new Wallet(
        this.id,
        this.playerId,
        this.currency,
        balanceAfter,
        this.nextVersion(),
      ),
      balanceBefore: this.balance,
      balanceAfter,
      direction: "CREDIT",
    };
  }

  debit(amount: Money): WalletBalanceChange {
    this.assertOperationAmount(amount);
    const balanceAfter = this.balance.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw new DomainError(
        DomainFailureCode.INSUFFICIENT_FUNDS,
        "Wallet has insufficient funds.",
      );
    }
    return {
      wallet: new Wallet(
        this.id,
        this.playerId,
        this.currency,
        balanceAfter,
        this.nextVersion(),
      ),
      balanceBefore: this.balance,
      balanceAfter,
      direction: "DEBIT",
    };
  }

  private assertOperationAmount(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError(
        DomainFailureCode.CURRENCY_MISMATCH,
        "Wallet operation currency does not match wallet currency.",
      );
    }
    if (!amount.isPositive()) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Wallet operation amount must be greater than zero.",
      );
    }
  }

  private nextVersion(): number {
    if (
      !Number.isSafeInteger(this.version) ||
      this.version < 1 ||
      this.version === Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Wallet version cannot be incremented safely.",
      );
    }
    return this.version + 1;
  }
}
