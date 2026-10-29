import { EntitySchema, OptionalProps, Type } from "@mikro-orm/core";
import { DomainFailureCode } from "../modules/wallets/domain/errors/domain-error";
import type { LedgerDirection } from "../modules/ledger/domain/entities/wallet-ledger-entry";
import type {
  WagerKind,
  WagerStatus,
} from "../modules/wagering/domain/entities/wager-transaction";

export type JsonRecord = Record<string, unknown>;

export class PersistenceAmountError extends Error {
  constructor() {
    super(
      "Persisted monetary amounts must be canonical, non-negative decimals with two fractional digits and at most 36 whole digits.",
    );
    this.name = "PersistenceAmountError";
  }
}

const CANONICAL_AMOUNT = /^(?:0|[1-9]\d{0,35})\.\d{2}$/;

function assertCanonicalAmount(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_AMOUNT.test(value)) {
    throw new PersistenceAmountError();
  }
}

class ExactAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    assertCanonicalAmount(value);
    return value;
  }

  override convertToJSValue(value: string): string {
    assertCanonicalAmount(value);
    return value;
  }

  override getColumnType(): string {
    return "numeric(38,2)";
  }
}

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  [OptionalProps]?: "responseSnapshot" | "retryCount";

  id!: string;
  providerId!: string | null;
  externalTransactionId!: string | null;
  playerId!: string;
  walletId!: string;
  currency!: string;
  roundId!: string | null;
  kind!: WagerKind;
  status!: WagerStatus;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  failureCode!: DomainFailureCode | null;
  createdAt!: Date;
  completedAt!: Date | null;
  idempotencyKey: string | null = null;
  payloadHash: string | null = null;
  gameId: string | null = null;
  referenceTransactionId: string | null = null;
  responseSnapshot: JsonRecord | null = null;
  nextRetryAt: Date | null = null;
  pendingReferenceExpiresAt: Date | null = null;
  retryCount = 0;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  amount!: string;
  currency!: string;
  direction!: LedgerDirection;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export type InboxMessageStatus = "PROCESSING" | "COMPLETED" | "FAILED";

export class InboxMessageRecord {
  [OptionalProps]?: "attempts" | "completedAt" | "failureCode" | "payload";

  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  status!: InboxMessageStatus;
  attempts = 0;
  payload: JsonRecord | null = null;
  receivedAt!: Date;
  completedAt: Date | null = null;
  failureCode: string | null = null;
}

export type OutboxMessageStatus =
  "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED";

export class OutboxMessageRecord {
  [OptionalProps]?:
    "attempts" | "lastError" | "leaseExpiresAt" | "leaseOwner" | "publishedAt";

  eventId!: string;
  eventType!: string;
  aggregateId!: string;
  payload!: JsonRecord;
  status!: OutboxMessageStatus;
  attempts = 0;
  nextAttemptAt!: Date;
  leaseOwner: string | null = null;
  leaseExpiresAt: Date | null = null;
  createdAt!: Date;
  publishedAt: Date | null = null;
  lastError: string | null = null;
}

const amountType = ExactAmountType;

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "text", fieldName: "player_id" },
    currency: { type: "text" },
    balance: {
      type: amountType,
      columnType: "numeric(38,2)",
    },
    version: { type: "integer" },
    createdAt: {
      type: Date,
      fieldName: "created_at",
      columnType: "timestamptz(3)",
    },
    updatedAt: {
      type: Date,
      fieldName: "updated_at",
      columnType: "timestamptz(3)",
    },
  },
});

export const WagerTransactionRecordSchema =
  new EntitySchema<WagerTransactionRecord>({
    class: WagerTransactionRecord,
    tableName: "wager_transactions",
    properties: {
      id: { type: "uuid", primary: true },
      providerId: { type: "text", fieldName: "provider_id", nullable: true },
      externalTransactionId: {
        type: "text",
        fieldName: "external_transaction_id",
        nullable: true,
      },
      playerId: { type: "text", fieldName: "player_id" },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      currency: { type: "text" },
      roundId: { type: "text", fieldName: "round_id", nullable: true },
      kind: { type: "text" },
      status: { type: "text" },
      amount: { type: amountType, columnType: "numeric(38,2)" },
      referenceExternalTransactionId: {
        type: "text",
        fieldName: "reference_external_transaction_id",
        nullable: true,
      },
      failureCode: {
        type: "text",
        fieldName: "failure_code",
        nullable: true,
      },
      createdAt: {
        type: Date,
        fieldName: "created_at",
        columnType: "timestamptz(3)",
      },
      completedAt: {
        type: Date,
        fieldName: "completed_at",
        columnType: "timestamptz(3)",
        nullable: true,
      },
      idempotencyKey: {
        type: "text",
        fieldName: "idempotency_key",
        nullable: true,
      },
      payloadHash: { type: "text", fieldName: "payload_hash", nullable: true },
      gameId: { type: "text", fieldName: "game_id", nullable: true },
      referenceTransactionId: {
        type: "uuid",
        fieldName: "reference_transaction_id",
        nullable: true,
      },
      responseSnapshot: {
        type: "json",
        fieldName: "response_snapshot",
        columnType: "jsonb",
        nullable: true,
      },
      nextRetryAt: {
        type: Date,
        fieldName: "next_retry_at",
        columnType: "timestamptz(3)",
        nullable: true,
      },
      pendingReferenceExpiresAt: {
        type: Date,
        fieldName: "pending_reference_expires_at",
        columnType: "timestamptz(3)",
        nullable: true,
      },
      retryCount: {
        type: "integer",
        fieldName: "retry_count",
        default: 0,
      },
    },
  });

export const LedgerEntryRecordSchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    amount: { type: amountType, columnType: "numeric(38,2)" },
    currency: { type: "text" },
    direction: { type: "text" },
    balanceBefore: {
      type: amountType,
      fieldName: "balance_before",
      columnType: "numeric(38,2)",
    },
    balanceAfter: {
      type: amountType,
      fieldName: "balance_after",
      columnType: "numeric(38,2)",
    },
    createdAt: {
      type: Date,
      fieldName: "created_at",
      columnType: "timestamptz(3)",
    },
  },
});

export const InboxMessageRecordSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", fieldName: "consumer_name", primary: true },
    messageId: { type: "text", fieldName: "message_id", primary: true },
    payloadHash: { type: "text", fieldName: "payload_hash" },
    status: { type: "text" },
    attempts: { type: "integer", default: 0 },
    payload: { type: "json", columnType: "jsonb", nullable: true },
    receivedAt: {
      type: Date,
      fieldName: "received_at",
      columnType: "timestamptz(3)",
    },
    completedAt: {
      type: Date,
      fieldName: "completed_at",
      columnType: "timestamptz(3)",
      nullable: true,
    },
    failureCode: {
      type: "text",
      fieldName: "failure_code",
      nullable: true,
    },
  },
});

export const OutboxMessageRecordSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    eventId: { type: "uuid", fieldName: "event_id", primary: true },
    eventType: { type: "text", fieldName: "event_type" },
    aggregateId: { type: "text", fieldName: "aggregate_id" },
    payload: { type: "json", columnType: "jsonb" },
    status: { type: "text" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: {
      type: Date,
      fieldName: "next_attempt_at",
      columnType: "timestamptz(3)",
    },
    leaseOwner: { type: "text", fieldName: "lease_owner", nullable: true },
    leaseExpiresAt: {
      type: Date,
      fieldName: "lease_expires_at",
      columnType: "timestamptz(3)",
      nullable: true,
    },
    createdAt: {
      type: Date,
      fieldName: "created_at",
      columnType: "timestamptz(3)",
    },
    publishedAt: {
      type: Date,
      fieldName: "published_at",
      columnType: "timestamptz(3)",
      nullable: true,
    },
    lastError: { type: "text", fieldName: "last_error", nullable: true },
  },
});
