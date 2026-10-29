import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { WalletsModule } from "./modules/wallets/wallets.module";

@Module({
  imports: [HealthModule, WalletsModule],
})
export class AppModule {}
