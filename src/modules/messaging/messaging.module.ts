import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WagerApplicationService } from "../wagering/application/wager-application-service";
import { WagerApplicationModule } from "../wagering/application/wager-application.module";
import { OutboxPublisher } from "./application/outbox-publisher";
import { PendingReferenceReprocessor } from "./application/pending-reference-reprocessor";
import { SqsWagerConsumer } from "./application/sqs-wager-consumer";
import { SqsQueueClient } from "./infrastructure/sqs-queue-client";

@Module({
  imports: [PersistenceModule, WagerApplicationModule],
  providers: [
    {
      provide: SqsQueueClient,
      useFactory: () => new SqsQueueClient(),
    },
    {
      provide: SqsWagerConsumer,
      inject: [MikroORM, WagerApplicationService, SqsQueueClient],
      useFactory: (
        orm: MikroORM,
        wagers: WagerApplicationService,
        sqs: SqsQueueClient,
      ) => new SqsWagerConsumer(orm, wagers, sqs),
    },
    {
      provide: OutboxPublisher,
      inject: [MikroORM, SqsQueueClient],
      useFactory: (orm: MikroORM, sqs: SqsQueueClient) =>
        new OutboxPublisher(orm, sqs),
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
    SqsQueueClient,
    SqsWagerConsumer,
  ],
})
export class MessagingModule {}
