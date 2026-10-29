import { DomainFailureCode } from "../../wallets/domain/errors/domain-error";
import { WagerKind } from "../../wagering/domain/entities/wager-transaction";

export interface IntegrationEventEnvelope<TEventType extends string, TData> {
  eventId: string;
  eventType: TEventType;
  version: 1;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: TData;
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: Exclude<WagerKind, "OPENING">;
  amount: string;
  currency: string;
  walletBalance: string;
  ledgerEntryId: string | null;
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: Exclude<WagerKind, "OPENING">;
  amount: string;
  currency: string;
  failureCode: DomainFailureCode;
}

export interface WalletBalanceChangedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: Exclude<WagerKind, "OPENING">;
  amount: string;
  currency: string;
}

export type WagerProcessedIntegrationEvent = IntegrationEventEnvelope<
  "WagerTransactionProcessed",
  WagerTransactionProcessedData
>;

export type WagerRejectedIntegrationEvent = IntegrationEventEnvelope<
  "WagerTransactionRejected",
  WagerTransactionRejectedData
>;

export type WalletBalanceChangedIntegrationEvent = IntegrationEventEnvelope<
  "WalletBalanceChanged",
  WalletBalanceChangedData
>;

export type WagerTransactionPendingReferenceIntegrationEvent =
  IntegrationEventEnvelope<
    "WagerTransactionPendingReference",
    WagerTransactionPendingReferenceData
  >;

export type WagerIntegrationEvent =
  | WagerProcessedIntegrationEvent
  | WagerRejectedIntegrationEvent
  | WalletBalanceChangedIntegrationEvent
  | WagerTransactionPendingReferenceIntegrationEvent;
