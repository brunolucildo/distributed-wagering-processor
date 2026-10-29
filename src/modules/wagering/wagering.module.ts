import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WagerApplicationService } from "./application/wager-application-service";
import {
  ProviderWagerController,
  WagerController,
} from "./presentation/http/wager.controller";

@Module({
  imports: [PersistenceModule],
  controllers: [WagerController, ProviderWagerController],
  providers: [
    {
      provide: WagerApplicationService,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new WagerApplicationService(orm),
    },
  ],
  exports: [WagerApplicationService],
})
export class WageringModule {}
