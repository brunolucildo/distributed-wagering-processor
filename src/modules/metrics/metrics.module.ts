import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SqsClientModule } from "../messaging/infrastructure/sqs-client.module";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

@Module({
  imports: [PersistenceModule, SqsClientModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
