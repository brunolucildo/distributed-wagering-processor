import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";

export interface LedgerPosition {
  createdAt: string;
  id: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface Reconciliation {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: number;
}

export abstract class LedgerRepository {
  abstract list(
    walletId: string,
    limit: number,
    after?: LedgerPosition,
  ): Promise<WalletLedgerEntry[]>;
  abstract reconcile(walletId: string): Promise<Reconciliation | null>;
}
