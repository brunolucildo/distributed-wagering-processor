import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HealthModule } from "./modules/health/health.module";
import { WalletsModule } from "./modules/wallets/wallets.module";
import { WalletHttpExceptionFilter } from "./modules/wallets/presentation/http/wallet-http-exception.filter";

@Module({
  imports: [HealthModule, WalletsModule],
  providers: [{ provide: APP_FILTER, useClass: WalletHttpExceptionFilter }],
})
export class AppModule {}
