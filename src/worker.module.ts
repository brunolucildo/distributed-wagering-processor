import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
  imports: [HealthModule, MessagingModule, MetricsModule, ObservabilityModule],
})
export class WorkerModule {}
