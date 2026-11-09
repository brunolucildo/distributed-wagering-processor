import { randomUUID } from "node:crypto";
import type { WalletLedgerEntry } from "../../ledger/domain/entities/wallet-ledger-entry";
import type { LedgerDirection } from "../../ledger/domain/entities/wallet-ledger-entry";
import type { Wallet } from "../../wallets/domain/entities/wallet";
import type { DomainFailureCode } from "../../wallets/domain/errors/domain-error";
import type { MoneyProps } from "../../wallets/domain/value-objects/money";
import type {
  ExternalWagerKind,
  WagerTransaction,
} from "../../wagering/domain/entities/wager-transaction";

/** Serialized envelope stored in the Outbox payload and published to SQS. */
export interface IntegrationEventEnvelope<TData> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: TData;
}

export interface IntegrationEventProps<TData> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: TData;
}

/** Context shared by every event produced in one financial transaction. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  eventId?: string;
}

export abstract class IntegrationEvent<TData> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<TData>;

  protected constructor(props: IntegrationEventProps<TData>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Stable, versionable JSON envelope; money is always a decimal string. */
  toJSON(): IntegrationEventEnvelope<TData> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined
        ? { causationId: this.causationId }
        : {}),
      occurredAt: this.occurredAt.toISOString(),
      data: this.data as TData,
    };
  }
}

function props<TData>(
  aggregateId: string,
  data: TData,
  context: EventContext,
): IntegrationEventProps<TData> {
  return {
    eventId: context.eventId ?? randomUUID(),
    aggregateId,
    correlationId: context.correlationId,
    ...(context.causationId !== undefined
      ? { causationId: context.causationId }
      : {}),
    occurredAt: context.occurredAt,
    data,
  };
}

interface ExternalIdentity {
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  kind: ExternalWagerKind;
}

function externalIdentity(transaction: WagerTransaction): ExternalIdentity {
  if (
    !transaction.providerId ||
    !transaction.externalTransactionId ||
    !transaction.roundId ||
    transaction.kind === "OPENING"
  ) {
    throw new Error(
      "External wager identity is required for integration events.",
    );
  }
  return {
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    roundId: transaction.roundId,
    kind: transaction.kind,
  };
}

export interface WagerTransactionProcessedData extends ExternalIdentity {
  transactionId: string;
  playerId: string;
  walletId: string;
  money: MoneyProps;
  balance: MoneyProps;
  ledgerEntryId: string | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | null,
    context: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      props(
        transaction.id,
        {
          transactionId: transaction.id,
          ...externalIdentity(transaction),
          playerId: transaction.playerId,
          walletId: transaction.walletId,
          money: transaction.amount.toJSON(),
          balance: wallet.balance.toJSON(),
          ledgerEntryId: ledgerEntry?.id ?? null,
        },
        context,
      ),
    );
  }
}

export interface WagerTransactionRejectedData extends ExternalIdentity {
  transactionId: string;
  playerId: string;
  walletId: string;
  money: MoneyProps;
  failureCode: DomainFailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error("A rejected transaction requires a failure code.");
    }
    return new WagerTransactionRejected(
      props(
        transaction.id,
        {
          transactionId: transaction.id,
          ...externalIdentity(transaction),
          playerId: transaction.playerId,
          walletId: transaction.walletId,
          money: transaction.amount.toJSON(),
          failureCode: transaction.failureCode,
        },
        context,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.amount.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        context,
      ),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends ExternalIdentity {
  transactionId: string;
  referenceExternalTransactionId: string;
  playerId: string;
  walletId: string;
  money: MoneyProps;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error("A pending-reference event requires a reference.");
    }
    return new WagerTransactionPendingReference(
      props(
        transaction.id,
        {
          transactionId: transaction.id,
          ...externalIdentity(transaction),
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId,
          playerId: transaction.playerId,
          walletId: transaction.walletId,
          money: transaction.amount.toJSON(),
        },
        context,
      ),
    );
  }
}

export type WagerIntegrationEvent =
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WalletBalanceChanged
  | WagerTransactionPendingReference;
