import {
  DomainError,
  DomainFailureCode,
} from "../../../wallets/domain/errors/domain-error";
import { Money } from "../../../wallets/domain/value-objects/money";

export const WagerKind = {
  OPENING: "OPENING",
  BET: "BET",
  WIN: "WIN",
  LOSS: "LOSS",
  REFUND: "REFUND",
  ROLLBACK: "ROLLBACK",
} as const;

export type WagerKind = (typeof WagerKind)[keyof typeof WagerKind];
export type ExternalWagerKind = Exclude<WagerKind, "OPENING">;

export const WagerStatus = {
  PENDING: "PENDING",
  PENDING_REFERENCE: "PENDING_REFERENCE",
  PROCESSED: "PROCESSED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
} as const;

export type WagerStatus = (typeof WagerStatus)[keyof typeof WagerStatus];
export type TerminalWagerStatus = "PROCESSED" | "REJECTED" | "FAILED";

export interface CreateWagerTransaction {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  kind: ExternalWagerKind;
  amount: Money;
  referenceExternalTransactionId?: string;
  referenceAvailable?: boolean;
  createdAt: string | Date;
}

export interface WagerTransactionSnapshot {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string | null;
  kind: WagerKind;
  status: WagerStatus;
  amount: string;
  referenceExternalTransactionId: string | null;
  failureCode: DomainFailureCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TransitionOptions {
  failureCode?: DomainFailureCode;
  occurredAt?: string | Date;
}

function timestamp(value: string | Date): string {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError(
      DomainFailureCode.INVALID_TRANSACTION,
      "Transaction timestamp must be a valid instant.",
    );
  }
  return date.toISOString();
}

function isTerminal(status: WagerStatus): status is TerminalWagerStatus {
  return status === "PROCESSED" || status === "REJECTED" || status === "FAILED";
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string | null,
    public readonly externalTransactionId: string | null,
    public readonly playerId: string,
    public readonly walletId: string,
    public readonly currency: string,
    public readonly roundId: string | null,
    public readonly kind: WagerKind,
    public readonly status: WagerStatus,
    public readonly amount: Money,
    public readonly referenceExternalTransactionId: string | null,
    public readonly failureCode: DomainFailureCode | null,
    public readonly createdAt: string,
    public readonly completedAt: string | null,
  ) {
    Object.freeze(this);
  }

  static create(input: CreateWagerTransaction): WagerTransaction {
    const reference = input.referenceExternalTransactionId;
    if (reference !== undefined && !reference.trim()) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "A supplied reference transaction identifier cannot be blank.",
      );
    }
    if (
      !input.id.trim() ||
      !input.providerId.trim() ||
      !input.externalTransactionId.trim() ||
      !input.playerId.trim() ||
      !input.walletId.trim() ||
      !input.roundId.trim() ||
      !input.amount.isPositive() ||
      input.amount.currency !== input.currency
    ) {
      throw new DomainError(
        input.amount.currency !== input.currency
          ? DomainFailureCode.CURRENCY_MISMATCH
          : DomainFailureCode.INVALID_TRANSACTION,
        "Wager identity, round, currency, and positive amount are required.",
      );
    }
    if (
      (input.kind === "REFUND" || input.kind === "ROLLBACK") &&
      (!reference || !reference.trim())
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        `${input.kind} requires a reference transaction.`,
      );
    }
    if (
      reference !== undefined &&
      input.kind !== "WIN" &&
      input.kind !== "REFUND" &&
      input.kind !== "ROLLBACK"
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        `${input.kind} cannot include a reference transaction.`,
      );
    }
    if (!["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(input.kind)) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "OPENING is internal and cannot be created as an external wager.",
      );
    }

    const referenceIsUnresolved =
      reference !== undefined && input.referenceAvailable !== true;
    return new WagerTransaction(
      input.id,
      input.providerId,
      input.externalTransactionId,
      input.playerId,
      input.walletId,
      input.currency,
      input.roundId,
      input.kind,
      referenceIsUnresolved ? "PENDING_REFERENCE" : "PENDING",
      input.amount,
      reference ?? null,
      null,
      timestamp(input.createdAt),
      null,
    );
  }

  static opening(input: {
    id: string;
    walletId: string;
    playerId: string;
    amount: Money;
    occurredAt: string | Date;
  }): WagerTransaction {
    if (
      !input.id.trim() ||
      !input.walletId.trim() ||
      !input.playerId.trim() ||
      !input.amount.isPositive()
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Opening transaction identifiers and a positive amount are required.",
      );
    }
    return new WagerTransaction(
      input.id,
      null,
      null,
      input.playerId,
      input.walletId,
      input.amount.currency,
      null,
      "OPENING",
      "PROCESSED",
      input.amount,
      null,
      null,
      timestamp(input.occurredAt),
      timestamp(input.occurredAt),
    );
  }

  static rehydrate(snapshot: WagerTransactionSnapshot): WagerTransaction {
    return new WagerTransaction(
      snapshot.id,
      snapshot.providerId,
      snapshot.externalTransactionId,
      snapshot.playerId,
      snapshot.walletId,
      snapshot.currency,
      snapshot.roundId,
      snapshot.kind,
      snapshot.status,
      Money.rehydrate(snapshot.amount, snapshot.currency),
      snapshot.referenceExternalTransactionId,
      snapshot.failureCode,
      snapshot.createdAt,
      snapshot.completedAt,
    );
  }

  transition(
    nextStatus: WagerStatus,
    options: TransitionOptions = {},
  ): WagerTransaction {
    if (isTerminal(this.status)) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        `Terminal transaction state ${this.status} is immutable.`,
      );
    }

    const valid =
      (this.status === "PENDING" &&
        ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"].includes(
          nextStatus,
        )) ||
      (this.status === "PENDING_REFERENCE" &&
        ["PROCESSED", "REJECTED", "FAILED"].includes(nextStatus));

    if (!valid) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        `Transition ${this.status} -> ${nextStatus} is not allowed.`,
      );
    }
    if (nextStatus === "REJECTED" && !options.failureCode) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        "Rejected transactions require a stable failure code.",
      );
    }
    if (
      nextStatus !== "REJECTED" &&
      nextStatus !== "FAILED" &&
      options.failureCode !== undefined
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        "Only rejected or failed transactions can have a failure code.",
      );
    }
    if (
      nextStatus === "FAILED" &&
      options.failureCode !== DomainFailureCode.PERMANENT_PROCESSING_FAILURE
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_STATE_TRANSITION,
        "FAILED is reserved for permanent, transaction-specific processing failures.",
      );
    }

    const completedAt =
      nextStatus === "PROCESSED" ||
      nextStatus === "REJECTED" ||
      nextStatus === "FAILED"
        ? timestamp(options.occurredAt ?? new Date())
        : null;
    return new WagerTransaction(
      this.id,
      this.providerId,
      this.externalTransactionId,
      this.playerId,
      this.walletId,
      this.currency,
      this.roundId,
      this.kind,
      nextStatus,
      this.amount,
      this.referenceExternalTransactionId,
      options.failureCode ?? null,
      this.createdAt,
      completedAt,
    );
  }

  hasSameExternalIdentity(other: WagerTransaction): boolean {
    return (
      this.providerId !== null &&
      this.providerId === other.providerId &&
      this.externalTransactionId !== null &&
      this.externalTransactionId === other.externalTransactionId
    );
  }
}
