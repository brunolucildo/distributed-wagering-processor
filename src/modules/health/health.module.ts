import { Module } from "@nestjs/common";
import { MessagingModule } from "../messaging/messaging.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [PersistenceModule, MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
