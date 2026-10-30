import { Module } from "@nestjs/common";
import { SqsQueueClient } from "./sqs-queue-client";

@Module({
  providers: [
    {
      provide: SqsQueueClient,
      useFactory: () => new SqsQueueClient(),
    },
  ],
  exports: [SqsQueueClient],
})
export class SqsClientModule {}
