import { MikroORM } from "@mikro-orm/postgresql";
import { LedgerEntryRecord } from "../../../database/entities";
import { Money } from "../../wallets/domain/value-objects/money";
import {
  LedgerPosition,
  LedgerRepository,
  Reconciliation,
} from "../application/ports/ledger-repository";
import { WalletLedgerEntry } from "../domain/entities/wallet-ledger-entry";

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: string;
}

export class PostgresLedgerRepository extends LedgerRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async list(
    walletId: string,
    limit: number,
    after?: LedgerPosition,
  ): Promise<WalletLedgerEntry[]> {
    const records = await this.orm.em.fork().find(
      LedgerEntryRecord,
      {
        walletId,
        ...(after
          ? {
              $or: [
                { createdAt: { $gt: new Date(after.createdAt) } },
                { createdAt: new Date(after.createdAt), id: { $gt: after.id } },
              ],
            }
          : {}),
      },
      { orderBy: { createdAt: "ASC", id: "ASC" }, limit },
    );
    return records.map((record) =>
      WalletLedgerEntry.rehydrate({
        id: record.id,
        walletId: record.walletId,
        transactionId: record.transactionId,
        amount: record.amount,
        currency: record.currency,
        direction: record.direction,
        balanceBefore: record.balanceBefore,
        balanceAfter: record.balanceAfter,
        occurredAt: record.createdAt.toISOString(),
      }),
    );
  }

  override async reconcile(walletId: string): Promise<Reconciliation | null> {
    // One statement gives the wallet and ledger the same MVCC snapshot.
    const rows = await this.orm.em
      .fork()
      .getConnection()
      .execute<ReconciliationRow[]>(
        `select w.id as wallet_id, w.currency, w.balance::text as stored_balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated_balance,
        count(l.id)::text as checked_entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ? group by w.id`,
        [walletId],
      );
    const row = rows[0];
    if (!row) return null;
    const stored = Money.rehydrate(row.stored_balance, row.currency);
    // SUM over an empty ledger is the integer 0, not a decimal string.
    const calculated = Money.rehydrate(
      row.calculated_balance === "0" ? "0.00" : row.calculated_balance,
      row.currency,
    );
    return {
      walletId: row.wallet_id,
      currency: row.currency,
      storedBalance: stored.toString(),
      calculatedBalance: calculated.toString(),
      difference: stored.subtract(calculated).toString(),
      consistent: stored.equals(calculated),
      checkedEntries: Number(row.checked_entries),
    };
  }
}
