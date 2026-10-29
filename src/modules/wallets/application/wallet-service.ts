import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LedgerPage,
  LedgerPosition,
  LedgerRepository,
  Reconciliation,
} from "../../ledger/application/ports/ledger-repository";
import { Wallet } from "../domain/entities/wallet";
import { Money } from "../domain/value-objects/money";
import { WalletRepository } from "./ports/wallet-repository";
import {
  InvalidWalletRequestError,
  WalletNotFoundError,
} from "./wallet-errors";

const CursorSchema = z
  .object({
    v: z.literal(1),
    walletId: z.string().uuid(),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

export class WalletService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async create(input: {
    playerId: string;
    currency: string;
    openingBalance: string;
  }): Promise<Wallet> {
    const balance = Money.parse(input.openingBalance, input.currency);
    if (balance.toString().length > 39) {
      throw new InvalidWalletRequestError(
        "Persisted money supports at most 36 integer digits and two fractional digits.",
      );
    }
    return this.wallets.create(
      Wallet.open({
        id: randomUUID(),
        playerId: input.playerId,
        currency: input.currency,
        openingBalance: balance,
        openingTransactionId: randomUUID(),
        openingLedgerEntryId: randomUUID(),
        openedAt: new Date(),
      }),
    );
  }

  async get(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    return wallet;
  }

  async listLedger(
    walletId: string,
    query: { cursor?: string | undefined; limit?: number | undefined } = {},
  ): Promise<LedgerPage> {
    const requestedLimit = query.limit ?? 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new InvalidWalletRequestError(
        "Ledger limit must be a positive integer.",
      );
    }
    const limit = Math.min(requestedLimit, 100);
    let after: LedgerPosition | undefined;
    if (query.cursor !== undefined) {
      const cursor = query.cursor;
      if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new InvalidWalletRequestError("Invalid ledger cursor.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new InvalidWalletRequestError("Invalid ledger cursor.");
      }
      const result = CursorSchema.safeParse(decoded);
      if (!result.success || result.data.walletId !== walletId) {
        throw new InvalidWalletRequestError(
          "Invalid ledger cursor for this wallet.",
        );
      }
      after = { createdAt: result.data.createdAt, id: result.data.id };
    }
    await this.get(walletId);
    const entries = await this.ledger.list(walletId, limit + 1, after);
    const hasMore = entries.length > limit;
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                walletId,
                createdAt: last.occurredAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }

  async reconcile(walletId: string): Promise<Reconciliation> {
    const result = await this.ledger.reconcile(walletId);
    if (!result) {
      throw new WalletNotFoundError();
    }
    return result;
  }
}
