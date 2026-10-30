import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../../persistence/persistence.module";
import { WagerApplicationService } from "./wager-application-service";
import { MetricsModule } from "../../metrics/metrics.module";
import { MetricsService } from "../../metrics/metrics.service";

@Module({
  imports: [PersistenceModule, MetricsModule],
  providers: [
    {
      provide: WagerApplicationService,
      inject: [MikroORM, MetricsService],
      useFactory: (orm: MikroORM, metrics: MetricsService) =>
        new WagerApplicationService(orm, metrics),
    },
  ],
  exports: [WagerApplicationService],
})
export class WagerApplicationModule {}
