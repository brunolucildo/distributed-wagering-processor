import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../../persistence/persistence.module";
import { WagerApplicationService } from "./wager-application-service";

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: WagerApplicationService,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new WagerApplicationService(orm),
    },
  ],
  exports: [WagerApplicationService],
})
export class WagerApplicationModule {}
