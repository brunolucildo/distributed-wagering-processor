import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HealthModule } from "./modules/health/health.module";
import { WalletsModule } from "./modules/wallets/wallets.module";
import { WalletHttpExceptionFilter } from "./modules/wallets/presentation/http/wallet-http-exception.filter";
import { WageringModule } from "./modules/wagering/wagering.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
  imports: [
    HealthModule,
    WalletsModule,
    WageringModule,
    MessagingModule,
    MetricsModule,
    ObservabilityModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: WalletHttpExceptionFilter }],
})
export class AppModule {}
