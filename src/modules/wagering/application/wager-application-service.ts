import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  DriverException,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  JsonRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../../../database/entities";
import {
  DomainError,
  DomainFailureCode,
} from "../../wallets/domain/errors/domain-error";
import { WalletNotFoundError } from "../../wallets/application/wallet-errors";
import { Wallet } from "../../wallets/domain/entities/wallet";
import { Money } from "../../wallets/domain/value-objects/money";
import type { WalletLedgerEntry } from "../../ledger/domain/entities/wallet-ledger-entry";
import {
  IntegrationEventEnvelope,
  WagerIntegrationEvent,
} from "../../messaging/contracts/integration-events";
import { ProcessWager } from "../domain/services/process-wager";
import {
  ExternalWagerKind,
  WagerStatus,
  WagerTransaction,
} from "../domain/entities/wager-transaction";
import {
  WagerConflictError,
  WagerNotFoundError,
  WagerPersistenceUnavailableError,
  WagerSubmissionBody,
  WagerSubmissionResult,
  WagerTransactionView,
} from "./wager-errors";

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | undefined;
}

interface NormalizedWager extends Omit<
  SubmitWagerInput,
  "referenceExternalTransactionId"
> {
  referenceExternalTransactionId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  amount: Money;
}

interface ExistingWagerRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  status: WagerStatus;
  failure_code: DomainFailureCode | null;
  response_snapshot: {
    httpStatus: 200 | 202 | 422;
    body: WagerSubmissionBody;
  } | null;
}

interface ReferenceRow {
  id: string;
  provider_id: string | null;
  external_transaction_id: string | null;
  player_id: string;
  wallet_id: string;
  currency: string;
  round_id: string | null;
  kind: WagerTransaction["kind"];
  status: WagerStatus;
  amount: string;
  reference_external_transaction_id: string | null;
  failure_code: DomainFailureCode | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function isRetryableDatabaseError(error: unknown): boolean {
  if (!(error instanceof DriverException)) return false;
  const code = error.sqlState ?? error.code ?? "";
  return (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code.startsWith("08") ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transactionFromRow(row: ReferenceRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    currency: row.currency,
    roundId: row.round_id,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    referenceExternalTransactionId: row.reference_external_transaction_id,
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
  });
}

function jsonRecord(value: object): JsonRecord {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  if (
    !serialized ||
    typeof serialized !== "object" ||
    Array.isArray(serialized)
  ) {
    throw new Error("Integration event must serialize to a JSON object.");
  }
  return serialized as JsonRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class WagerApplicationService {
  private readonly logger = new Logger(WagerApplicationService.name);

  constructor(private readonly orm: MikroORM) {}

  async submit(
    input: SubmitWagerInput,
    idempotencyKey: string | undefined,
  ): Promise<WagerSubmissionResult> {
    const request = this.normalize(input, idempotencyKey);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          const identityLocks = [
            `wager-external:${request.providerId}:${request.externalTransactionId}`,
            `wager-idempotency:${request.providerId}:${request.idempotencyKey}`,
          ].sort();
          for (const identity of identityLocks) {
            await em.execute(
              "select pg_advisory_xact_lock(hashtextextended(?, 0))",
              [identity],
            );
          }

          const existing = await em.execute<ExistingWagerRow[]>(
            `select id, provider_id, external_transaction_id, idempotency_key,
                    payload_hash, status, failure_code, response_snapshot
             from wager_transactions
             where provider_id = ? and
               (external_transaction_id = ? or idempotency_key = ?)
             order by id`,
            [
              request.providerId,
              request.externalTransactionId,
              request.idempotencyKey,
            ],
          );
          if (existing.length > 0) {
            return this.replayOrConflict(existing, request);
          }

          const walletRecord = await em.findOne(
            WalletRecord,
            { id: request.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          if (!walletRecord) throw new WalletNotFoundError();

          const wallet = Wallet.rehydrate({
            id: walletRecord.id,
            playerId: walletRecord.playerId,
            currency: walletRecord.currency,
            balance: walletRecord.balance,
            version: walletRecord.version,
          });
          const referenceRow = request.referenceExternalTransactionId
            ? await em.execute<ReferenceRow[]>(
                `select id, provider_id, external_transaction_id, player_id,
                        wallet_id, currency, round_id, kind, status, amount::text as amount,
                        reference_external_transaction_id, failure_code,
                        created_at, completed_at
                 from wager_transactions
                 where provider_id = ? and external_transaction_id = ?
                 for update`,
                [request.providerId, request.referenceExternalTransactionId],
              )
            : [];
          const reference = referenceRow[0]
            ? transactionFromRow(referenceRow[0])
            : undefined;
          const transaction = WagerTransaction.create({
            id: randomUUID(),
            providerId: request.providerId,
            externalTransactionId: request.externalTransactionId,
            playerId: request.playerId,
            walletId: request.walletId,
            currency: request.money.currency,
            roundId: request.roundId,
            kind: request.kind,
            amount: request.amount,
            ...(request.referenceExternalTransactionId
              ? {
                  referenceExternalTransactionId:
                    request.referenceExternalTransactionId,
                }
              : {}),
            referenceAvailable: reference?.status === "PROCESSED",
            createdAt: new Date(),
          });
          const alreadyReversed = reference
            ? (
                await em.execute<{ exists: boolean }[]>(
                  `select exists (
                     select 1 from wager_transactions
                     where reference_transaction_id = ?
                       and status = 'PROCESSED'
                       and kind in ('REFUND', 'ROLLBACK')
                   ) as exists`,
                  [reference.id],
                )
              )[0]?.exists === true
            : false;
          const result = ProcessWager.apply(transaction, wallet, {
            ...(reference
              ? { reference: { status: "found", transaction: reference } }
              : {}),
            referenceAlreadyReversed: alreadyReversed,
            occurredAt: new Date(),
            ledgerEntryId: randomUUID(),
          });
          const savedAt = new Date();
          if (result.wallet && result.wallet.version !== walletRecord.version) {
            walletRecord.balance = result.wallet.balance.toString();
            walletRecord.version = result.wallet.version;
            walletRecord.updatedAt = savedAt;
          }
          const httpStatus = this.httpStatus(result.transaction.status);
          const body: WagerSubmissionBody = {
            transactionId: result.transaction.id,
            status: result.transaction.status,
            ...(result.transaction.failureCode
              ? { failureCode: result.transaction.failureCode }
              : {}),
            walletBalance: (result.wallet ?? wallet).balance.toString(),
            idempotentReplay: false,
          };
          const responseSnapshot = { httpStatus, body };
          const retryAt =
            result.transaction.status === "PENDING_REFERENCE"
              ? new Date(savedAt.getTime() + 1_000)
              : null;
          const expiresAt =
            result.transaction.status === "PENDING_REFERENCE"
              ? new Date(savedAt.getTime() + 24 * 60 * 60 * 1_000)
              : null;
          const transactionRecord = em.create(WagerTransactionRecord, {
            id: result.transaction.id,
            providerId: result.transaction.providerId,
            externalTransactionId: result.transaction.externalTransactionId,
            idempotencyKey: request.idempotencyKey,
            payloadHash: request.payloadHash,
            playerId: result.transaction.playerId,
            walletId: result.transaction.walletId,
            currency: result.transaction.currency,
            roundId: result.transaction.roundId,
            gameId: request.gameId,
            kind: result.transaction.kind,
            status: result.transaction.status,
            amount: result.transaction.amount.toString(),
            referenceExternalTransactionId:
              result.transaction.referenceExternalTransactionId,
            referenceTransactionId: reference?.id ?? null,
            failureCode: result.transaction.failureCode,
            createdAt: new Date(result.transaction.createdAt),
            completedAt: result.transaction.completedAt
              ? new Date(result.transaction.completedAt)
              : null,
            responseSnapshot,
            nextRetryAt: retryAt,
            pendingReferenceExpiresAt: expiresAt,
            retryCount: 0,
          });
          em.persist(transactionRecord);
          await em.flush();
          if (result.ledgerEntry) {
            const entry = result.ledgerEntry;
            em.persist(
              em.create(LedgerEntryRecord, {
                id: entry.id,
                walletId: entry.walletId,
                transactionId: entry.transactionId,
                amount: entry.amount.toString(),
                currency: entry.amount.currency,
                direction: entry.direction,
                balanceBefore: entry.balanceBefore.toString(),
                balanceAfter: entry.balanceAfter.toString(),
                createdAt: new Date(entry.occurredAt),
              }),
            );
          }
          const events = this.integrationEvents(
            result.transaction,
            result.wallet ?? wallet,
            result.ledgerEntry,
            savedAt,
          );
          for (const event of events) {
            em.persist(
              em.create(OutboxMessageRecord, {
                eventId: event.eventId,
                eventType: event.eventType,
                aggregateId: event.aggregateId,
                payload: jsonRecord(event),
                status: "PENDING",
                attempts: 0,
                nextAttemptAt: savedAt,
                createdAt: savedAt,
              }),
            );
          }
          await em.flush();
          return { httpStatus, body };
        });
      } catch (error) {
        if (error instanceof WagerNotFoundError) throw error;
        if (error instanceof UniqueConstraintViolationException) {
          const winner = await this.findIdentityWinner(request);
          if (winner) return this.replayOrConflict(winner, request);
        }
        if (!isRetryableDatabaseError(error)) throw error;
        if (attempt === 2) {
          this.logger.error(
            JSON.stringify({
              event: "wager_persistence_retry_exhausted",
              sqlState:
                error instanceof DriverException
                  ? (error.sqlState ?? error.code ?? "unknown")
                  : "unknown",
            }),
          );
          throw new WagerPersistenceUnavailableError();
        }
        await sleep(5 + Math.floor(Math.random() * 20) * (attempt + 1));
      }
    }
    throw new WagerPersistenceUnavailableError();
  }

  async findById(id: string): Promise<WagerTransactionView> {
    const row = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, { id });
    if (!row) throw new WagerNotFoundError();
    return this.toView(row);
  }

  async findByExternalIdentity(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const row = await this.orm.em.fork().findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    if (!row) throw new WagerNotFoundError();
    return this.toView(row);
  }

  private normalize(
    input: SubmitWagerInput,
    idempotencyKey: string | undefined,
  ): NormalizedWager {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "The Idempotency-Key header is required.",
      );
    }
    const key = idempotencyKey.trim();
    if (key.length > 200) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "The Idempotency-Key header must not exceed 200 characters.",
      );
    }
    const amount = Money.parse(input.money.amount, input.money.currency);
    if (amount.toString().length > 39) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Persisted money supports at most 36 integer digits and two fractional digits.",
      );
    }
    const businessPayload = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: amount.toString(), currency: input.money.currency },
      ...(input.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }
        : {}),
    };
    const payloadHash = createHash("sha256")
      .update(canonicalize(businessPayload))
      .digest("hex");
    return {
      ...businessPayload,
      referenceExternalTransactionId:
        input.referenceExternalTransactionId ?? null,
      idempotencyKey: key,
      payloadHash,
      amount,
    };
  }

  private replayOrConflict(
    existing: ExistingWagerRow[],
    request: NormalizedWager,
  ): WagerSubmissionResult {
    if (existing.length !== 1) throw new WagerConflictError();
    const row = existing[0];
    if (
      !row ||
      row.provider_id !== request.providerId ||
      row.external_transaction_id !== request.externalTransactionId ||
      row.idempotency_key !== request.idempotencyKey ||
      row.payload_hash !== request.payloadHash ||
      !row.response_snapshot
    ) {
      throw new WagerConflictError();
    }
    return {
      httpStatus: row.response_snapshot.httpStatus,
      body: { ...row.response_snapshot.body, idempotentReplay: true },
    };
  }

  private async findIdentityWinner(
    request: NormalizedWager,
  ): Promise<ExistingWagerRow[] | null> {
    const rows = await this.orm.em
      .fork()
      .getConnection()
      .execute<ExistingWagerRow[]>(
        `select id, provider_id, external_transaction_id, idempotency_key,
                payload_hash, status, failure_code, response_snapshot
         from wager_transactions
         where provider_id = ? and
           (external_transaction_id = ? or idempotency_key = ?)
         order by id`,
        [
          request.providerId,
          request.externalTransactionId,
          request.idempotencyKey,
        ],
      );
    return rows.length > 0 ? rows : null;
  }

  private httpStatus(status: WagerStatus): 200 | 202 | 422 {
    if (status === "PROCESSED") return 200;
    if (status === "PENDING_REFERENCE") return 202;
    if (status === "REJECTED") return 422;
    throw new Error(`Unexpected uncommitted wager status: ${status}.`);
  }

  private integrationEvents(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | null,
    occurredAt: Date,
  ): WagerIntegrationEvent[] {
    const eventBase = {
      version: 1 as const,
      aggregateId: transaction.id,
      correlationId: randomUUID(),
      occurredAt: occurredAt.toISOString(),
    };
    if (
      !transaction.providerId ||
      !transaction.externalTransactionId ||
      !transaction.roundId
    ) {
      throw new Error(
        "External wager identity is required for integration events.",
      );
    }
    if (transaction.status === "PROCESSED") {
      const processed: IntegrationEventEnvelope<
        "WagerTransactionProcessed",
        Extract<
          WagerIntegrationEvent,
          { eventType: "WagerTransactionProcessed" }
        >["data"]
      > = {
        ...eventBase,
        eventId: randomUUID(),
        eventType: "WagerTransactionProcessed",
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          playerId: transaction.playerId,
          walletId: transaction.walletId,
          roundId: transaction.roundId,
          kind: transaction.kind as Exclude<
            WagerTransaction["kind"],
            "OPENING"
          >,
          amount: transaction.amount.toString(),
          currency: transaction.currency,
          walletBalance: wallet.balance.toString(),
          ledgerEntryId: ledgerEntry?.id ?? null,
        },
      };
      const events: WagerIntegrationEvent[] = [processed];
      if (ledgerEntry) {
        events.push({
          ...eventBase,
          eventId: randomUUID(),
          aggregateId: wallet.id,
          eventType: "WalletBalanceChanged",
          data: {
            transactionId: transaction.id,
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balanceBefore: ledgerEntry.balanceBefore.toString(),
            balanceAfter: ledgerEntry.balanceAfter.toString(),
            walletVersion: wallet.version,
          },
        });
      }
      return events;
    }
    if (transaction.status === "REJECTED" && transaction.failureCode) {
      return [
        {
          ...eventBase,
          eventId: randomUUID(),
          eventType: "WagerTransactionRejected",
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            roundId: transaction.roundId,
            kind: transaction.kind as Exclude<
              WagerTransaction["kind"],
              "OPENING"
            >,
            amount: transaction.amount.toString(),
            currency: transaction.currency,
            failureCode: transaction.failureCode,
          },
        },
      ];
    }
    if (
      transaction.status === "PENDING_REFERENCE" &&
      transaction.referenceExternalTransactionId
    ) {
      return [
        {
          ...eventBase,
          eventId: randomUUID(),
          eventType: "WagerTransactionPendingReference",
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            roundId: transaction.roundId,
            kind: transaction.kind as Exclude<
              WagerTransaction["kind"],
              "OPENING"
            >,
            amount: transaction.amount.toString(),
            currency: transaction.currency,
          },
        },
      ];
    }
    throw new Error(
      `No integration event is defined for ${transaction.status}.`,
    );
  }

  private toView(row: WagerTransactionRecord): WagerTransactionView {
    const snapshotBody = row.responseSnapshot?.body;
    const balance =
      isRecord(snapshotBody) && typeof snapshotBody.walletBalance === "string"
        ? snapshotBody.walletBalance
        : null;
    return {
      transactionId: row.id,
      providerId: row.providerId ?? "",
      externalTransactionId: row.externalTransactionId ?? "",
      playerId: row.playerId,
      walletId: row.walletId,
      roundId: row.roundId ?? "",
      gameId: row.gameId ?? "",
      kind: row.kind,
      amount: row.amount,
      currency: row.currency,
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      status: row.status,
      failureCode: row.failureCode,
      walletBalance: balance,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
}
