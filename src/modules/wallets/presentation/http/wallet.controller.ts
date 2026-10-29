import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";
import { z } from "zod";
import { WalletService } from "../../application/wallet-service";
import { ReconciliationMonitor } from "./reconciliation-monitor";
import { WalletHttpExceptionFilter } from "./wallet-http-exception.filter";

const WalletIdSchema = z.string().uuid();
const CreateWalletSchema = z
  .object({
    playerId: z.string().trim().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/),
    openingBalance: z
      .string()
      .max(100)
      .regex(/^\d+\.\d{2}$/),
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
@UseFilters(WalletHttpExceptionFilter)
export class WalletController {
  constructor(
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(ReconciliationMonitor)
    private readonly monitor: ReconciliationMonitor,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    return this.wallets.create(CreateWalletSchema.parse(body));
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.wallets.get(WalletIdSchema.parse(walletId));
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
    return result;
  }
}
