import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../../../database/entities";
import { WalletRepository } from "../application/ports/wallet-repository";
import { WalletAlreadyExistsError } from "../application/wallet-errors";
import { Wallet, WalletOpening } from "../domain/entities/wallet";

export class PostgresWalletRepository extends WalletRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async create(opening: WalletOpening): Promise<Wallet> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const wallet = opening.wallet;
        const now = new Date();
        em.persist(
          em.create(WalletRecord, {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balance: wallet.balance.toString(),
            version: wallet.version,
            createdAt: now,
            updatedAt: now,
          }),
        );
        await em.flush();
        const transaction = opening.openingTransaction;
        if (transaction) {
          em.persist(
            em.create(WagerTransactionRecord, {
              id: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              playerId: transaction.playerId,
              walletId: transaction.walletId,
              currency: transaction.currency,
              roundId: transaction.roundId,
              kind: transaction.kind,
              status: transaction.status,
              amount: transaction.amount.toString(),
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,
              failureCode: transaction.failureCode,
              createdAt: new Date(transaction.createdAt),
              completedAt: transaction.completedAt
                ? new Date(transaction.completedAt)
                : null,
            }),
          );
          await em.flush();
        }
        const entry = opening.ledgerEntry;
        if (entry) {
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
        await em.flush();
        return wallet;
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        "constraint" in error &&
        error.constraint === "wallets_player_currency_unique"
      ) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  override async findById(id: string): Promise<Wallet | null> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id });
    return record
      ? Wallet.rehydrate({
          id: record.id,
          playerId: record.playerId,
          currency: record.currency,
          balance: record.balance,
          version: record.version,
        })
      : null;
  }
}
