import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { MessagingModule } from "./modules/messaging/messaging.module";

@Module({
  imports: [HealthModule, MessagingModule],
})
export class WorkerModule {}
