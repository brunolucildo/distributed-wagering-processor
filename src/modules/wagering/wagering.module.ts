import { Module } from "@nestjs/common";
import { WagerApplicationModule } from "./application/wager-application.module";
import {
  ProviderWagerController,
  WagerController,
} from "./presentation/http/wager.controller";
import { ProviderIdentityModule } from "../providers/provider-identity.module";

@Module({
  imports: [WagerApplicationModule, ProviderIdentityModule],
  controllers: [WagerController, ProviderWagerController],
  exports: [WagerApplicationModule],
})
export class WageringModule {}
