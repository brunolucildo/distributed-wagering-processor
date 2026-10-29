import {
  DomainError,
  DomainFailureCode,
} from "../../../wallets/domain/errors/domain-error";
import { Wallet } from "../../../wallets/domain/entities/wallet";
import { Money } from "../../../wallets/domain/value-objects/money";
import { WalletLedgerEntry } from "../../../ledger/domain/entities/wallet-ledger-entry";
import { WagerTransaction } from "../entities/wager-transaction";

export type ReferenceResolution =
  { status: "not-found" } | { status: "found"; transaction: WagerTransaction };

export interface ProcessWagerOptions {
  reference?: ReferenceResolution;
  /** Result of the durable reversal-uniqueness check, supplied by the use case. */
  referenceAlreadyReversed: boolean;
  occurredAt: string | Date;
  ledgerEntryId: string;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  wallet: Wallet | undefined;
  ledgerEntry: WalletLedgerEntry | null;
}

function rejection(
  transaction: WagerTransaction,
  wallet: Wallet | undefined,
  failureCode: DomainFailureCode,
  occurredAt: string | Date,
): ProcessWagerResult {
  return {
    transaction: transaction.transition("REJECTED", {
      failureCode,
      occurredAt,
    }),
    wallet,
    ledgerEntry: null,
  };
}

function sameReferenceIdentity(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): DomainFailureCode | null {
  if (transaction.providerId !== reference.providerId) {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  if (
    transaction.playerId !== reference.playerId ||
    transaction.walletId !== reference.walletId
  ) {
    return DomainFailureCode.WALLET_MISMATCH;
  }
  if (transaction.currency !== reference.currency) {
    return DomainFailureCode.CURRENCY_MISMATCH;
  }
  if (transaction.roundId !== reference.roundId) {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  if (
    transaction.referenceExternalTransactionId !==
    reference.externalTransactionId
  ) {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  return null;
}

function getReferenceKindFailure(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): DomainFailureCode | null {
  if (transaction.kind === "WIN" && reference.kind !== "BET") {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  if (transaction.kind === "REFUND" && reference.kind !== "BET") {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  if (
    transaction.kind === "ROLLBACK" &&
    !["BET", "WIN", "REFUND"].includes(reference.kind)
  ) {
    return DomainFailureCode.REFERENCE_INVALID;
  }
  return null;
}

function isReversal(kind: string): boolean {
  return kind === "REFUND" || kind === "ROLLBACK";
}

export class ProcessWager {
  static apply(
    transaction: WagerTransaction,
    wallet: Wallet | undefined,
    options: ProcessWagerOptions,
  ): ProcessWagerResult {
    if (
      transaction.status !== "PENDING" &&
      transaction.status !== "PENDING_REFERENCE"
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        "Only pending transactions can be processed.",
      );
    }
    if (!wallet) {
      return rejection(
        transaction,
        wallet,
        DomainFailureCode.WALLET_NOT_FOUND,
        options.occurredAt,
      );
    }
    if (
      transaction.walletId !== wallet.id ||
      transaction.playerId !== wallet.playerId
    ) {
      return rejection(
        transaction,
        wallet,
        DomainFailureCode.WALLET_MISMATCH,
        options.occurredAt,
      );
    }
    if (transaction.currency !== wallet.currency) {
      return rejection(
        transaction,
        wallet,
        DomainFailureCode.CURRENCY_MISMATCH,
        options.occurredAt,
      );
    }

    const requiresReference = isReversal(transaction.kind);
    const hasReference = transaction.referenceExternalTransactionId !== null;
    if (requiresReference && !hasReference) {
      return rejection(
        transaction,
        wallet,
        DomainFailureCode.INVALID_TRANSACTION,
        options.occurredAt,
      );
    }

    let reference: WagerTransaction | null = null;
    if (hasReference) {
      if (!options.reference || options.reference.status === "not-found") {
        return {
          transaction:
            transaction.status === "PENDING_REFERENCE"
              ? transaction
              : transaction.transition("PENDING_REFERENCE"),
          wallet,
          ledgerEntry: null,
        };
      }
      reference = options.reference.transaction;
      if (
        reference.status === "PENDING" ||
        reference.status === "PENDING_REFERENCE"
      ) {
        return {
          transaction:
            transaction.status === "PENDING_REFERENCE"
              ? transaction
              : transaction.transition("PENDING_REFERENCE"),
          wallet,
          ledgerEntry: null,
        };
      }
      if (reference.status !== "PROCESSED") {
        return rejection(
          transaction,
          wallet,
          DomainFailureCode.REFERENCE_INVALID,
          options.occurredAt,
        );
      }

      const identityFailure = sameReferenceIdentity(transaction, reference);
      if (identityFailure) {
        return rejection(
          transaction,
          wallet,
          identityFailure,
          options.occurredAt,
        );
      }
      const kindFailure = getReferenceKindFailure(transaction, reference);
      if (kindFailure) {
        return rejection(transaction, wallet, kindFailure, options.occurredAt);
      }
      if (
        isReversal(transaction.kind) &&
        !transaction.amount.equals(reference.amount)
      ) {
        return rejection(
          transaction,
          wallet,
          DomainFailureCode.REVERSAL_AMOUNT_MISMATCH,
          options.occurredAt,
        );
      }
      if (isReversal(transaction.kind)) {
        if (typeof options.referenceAlreadyReversed !== "boolean") {
          throw new Error(
            "Reversal processing requires a reference uniqueness check.",
          );
        }
        if (options.referenceAlreadyReversed) {
          return rejection(
            transaction,
            wallet,
            DomainFailureCode.REFERENCE_ALREADY_REVERSED,
            options.occurredAt,
          );
        }
      }
    }

    if (transaction.kind === "LOSS") {
      return {
        transaction: transaction.transition("PROCESSED", {
          occurredAt: options.occurredAt,
        }),
        wallet,
        ledgerEntry: null,
      };
    }

    let direction: "CREDIT" | "DEBIT";
    if (transaction.kind === "BET") {
      direction = "DEBIT";
    } else if (transaction.kind === "WIN" || transaction.kind === "REFUND") {
      direction = "CREDIT";
    } else if (transaction.kind === "ROLLBACK") {
      if (!reference) {
        return rejection(
          transaction,
          wallet,
          DomainFailureCode.REFERENCE_INVALID,
          options.occurredAt,
        );
      }
      direction = reference.kind === "BET" ? "CREDIT" : "DEBIT";
    } else {
      return rejection(
        transaction,
        wallet,
        DomainFailureCode.INVALID_TRANSACTION,
        options.occurredAt,
      );
    }

    let change;
    try {
      change =
        direction === "CREDIT"
          ? wallet.credit(transaction.amount)
          : wallet.debit(transaction.amount);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === DomainFailureCode.INSUFFICIENT_FUNDS
      ) {
        return rejection(
          transaction,
          wallet,
          transaction.kind === "BET"
            ? DomainFailureCode.INSUFFICIENT_FUNDS
            : DomainFailureCode.REVERSAL_WOULD_OVERDRAW,
          options.occurredAt,
        );
      }
      throw error;
    }

    const ledgerEntry = WalletLedgerEntry.create({
      id: options.ledgerEntryId,
      walletId: wallet.id,
      transactionId: transaction.id,
      amount: transaction.amount,
      direction,
      balanceBefore: change.balanceBefore,
      balanceAfter: change.balanceAfter,
      occurredAt: options.occurredAt,
    });
    return {
      transaction: transaction.transition("PROCESSED", {
        occurredAt: options.occurredAt,
      }),
      wallet: change.wallet,
      ledgerEntry,
    };
  }

  /** Marks an unresolved reference as permanently expired, without changing balance. */
  static expireReference(
    transaction: WagerTransaction,
    wallet: Wallet | undefined,
    occurredAt: string | Date,
  ): ProcessWagerResult {
    if (
      transaction.status !== "PENDING_REFERENCE" ||
      transaction.referenceExternalTransactionId === null
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        "Only a transaction waiting for a reference can expire.",
      );
    }
    return rejection(
      transaction,
      wallet,
      DomainFailureCode.REFERENCE_NOT_FOUND,
      occurredAt,
    );
  }
}

export function signedLedgerAmount(entry: WalletLedgerEntry): Money {
  return entry.direction === "CREDIT" ? entry.amount : entry.amount.negate();
}
