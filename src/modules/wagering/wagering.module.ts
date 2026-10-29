import { Module } from "@nestjs/common";
import { WagerApplicationModule } from "./application/wager-application.module";
import {
  ProviderWagerController,
  WagerController,
} from "./presentation/http/wager.controller";

@Module({
  imports: [WagerApplicationModule],
  controllers: [WagerController, ProviderWagerController],
  exports: [WagerApplicationModule],
})
export class WageringModule {}
