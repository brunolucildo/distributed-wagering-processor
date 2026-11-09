import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { WalletService } from "../../application/wallet-service";
import type { Wallet } from "../../domain/entities/wallet";
import { ReconciliationMonitor } from "./reconciliation-monitor";

const WalletIdSchema = z.string().uuid();
const MoneyPropsSchema = z
  .object({
    amount: z
      .string()
      .max(100)
      .regex(/^\d+\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
const CreateWalletSchema = z
  .object({
    playerId: z.string().trim().min(1).max(200),
    initialBalance: MoneyPropsSchema,
  })
  .strict();
const LedgerQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(ReconciliationMonitor)
    private readonly monitor: ReconciliationMonitor,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = CreateWalletSchema.parse(body);
    const wallet = await this.wallets.create({
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      openingBalance: input.initialBalance.amount,
    });
    return walletResponse(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return walletResponse(
      await this.wallets.get(WalletIdSchema.parse(walletId)),
    );
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const page = await this.wallets.listLedger(
      WalletIdSchema.parse(walletId),
      LedgerQuerySchema.parse(query),
    );
    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        amount: entry.amount.toString(),
        currency: entry.amount.currency,
        direction: entry.direction,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.occurredAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.wallets.reconcile(WalletIdSchema.parse(walletId));
    this.monitor.record(result);
    return {
      walletId: result.walletId,
      storedBalance: {
        amount: result.storedBalance,
        currency: result.currency,
      },
      calculatedBalance: {
        amount: result.calculatedBalance,
        currency: result.currency,
      },
      difference: { amount: result.difference, currency: result.currency },
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}

function walletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
