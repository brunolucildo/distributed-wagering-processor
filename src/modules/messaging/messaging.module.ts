import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WagerApplicationService } from "../wagering/application/wager-application-service";
import { WagerApplicationModule } from "../wagering/application/wager-application.module";
import { OutboxPublisher } from "./application/outbox-publisher";
import { PendingReferenceReprocessor } from "./application/pending-reference-reprocessor";
import { SqsWagerConsumer } from "./application/sqs-wager-consumer";
import { SqsQueueClient } from "./infrastructure/sqs-queue-client";
import { SqsClientModule } from "./infrastructure/sqs-client.module";
import { MetricsModule } from "../metrics/metrics.module";
import { MetricsService } from "../metrics/metrics.service";

@Module({
  imports: [
    PersistenceModule,
    WagerApplicationModule,
    MetricsModule,
    SqsClientModule,
  ],
  providers: [
    {
      provide: SqsWagerConsumer,
      inject: [
        MikroORM,
        WagerApplicationService,
        SqsQueueClient,
        MetricsService,
      ],
      useFactory: (
        orm: MikroORM,
        wagers: WagerApplicationService,
        sqs: SqsQueueClient,
        metrics: MetricsService,
      ) => new SqsWagerConsumer(orm, wagers, sqs, metrics),
    },
    {
      provide: OutboxPublisher,
      inject: [MikroORM, SqsQueueClient, MetricsService],
      useFactory: (
        orm: MikroORM,
        sqs: SqsQueueClient,
        metrics: MetricsService,
      ) => new OutboxPublisher(orm, sqs, metrics),
    },
    {
      provide: PendingReferenceReprocessor,
      inject: [MikroORM, WagerApplicationService],
      useFactory: (orm: MikroORM, wagers: WagerApplicationService) =>
        new PendingReferenceReprocessor(orm, wagers),
    },
  ],
  exports: [
    OutboxPublisher,
    PendingReferenceReprocessor,
    SqsClientModule,
    SqsWagerConsumer,
  ],
})
export class MessagingModule {}
