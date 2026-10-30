import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { LedgerRepository } from "../ledger/application/ports/ledger-repository";
import { PostgresLedgerRepository } from "../ledger/infrastructure/postgres-ledger-repository";
import { PersistenceModule } from "../persistence/persistence.module";
import { WalletRepository } from "./application/ports/wallet-repository";
import { WalletService } from "./application/wallet-service";
import { PostgresWalletRepository } from "./infrastructure/postgres-wallet-repository";
import { ReconciliationMonitor } from "./presentation/http/reconciliation-monitor";
import { WalletController } from "./presentation/http/wallet.controller";
import { MetricsModule } from "../metrics/metrics.module";
import { MetricsService } from "../metrics/metrics.service";

@Module({
  imports: [PersistenceModule, MetricsModule],
  controllers: [WalletController],
  providers: [
    {
      provide: WalletRepository,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new PostgresWalletRepository(orm),
    },
    {
      provide: LedgerRepository,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new PostgresLedgerRepository(orm),
    },
    {
      provide: WalletService,
      inject: [WalletRepository, LedgerRepository],
      useFactory: (wallets: WalletRepository, ledger: LedgerRepository) =>
        new WalletService(wallets, ledger),
    },
    {
      provide: ReconciliationMonitor,
      inject: [MetricsService],
      useFactory: (metrics: MetricsService) =>
        new ReconciliationMonitor(metrics),
    },
  ],
  exports: [WalletService, LedgerRepository],
})
export class WalletsModule {}
