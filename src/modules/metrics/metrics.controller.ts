import { Controller, Get, Header } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../config/environment";
import { SqsQueueClient } from "../messaging/infrastructure/sqs-queue-client";
import { MetricsService } from "./metrics.service";

interface OutboxBacklog {
  pending_count: number;
  oldest_age_seconds: number;
}

@Controller()
export class MetricsController {
  constructor(
    private readonly orm: MikroORM,
    private readonly metricsService: MetricsService,
    private readonly sqs: SqsQueueClient,
  ) {}

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics(): Promise<string> {
    const [backlog] = await this.orm.em.fork().execute<OutboxBacklog[]>(
      `select count(*)::int as pending_count,
              coalesce(extract(epoch from (now() - min(created_at))), 0)::float8
                as oldest_age_seconds
       from outbox_messages
       where status in ('PENDING', 'PROCESSING')`,
    );
    if (!backlog) throw new Error("Outbox metrics query returned no result.");
    this.metricsService.recordOutboxBacklog(
      backlog.pending_count,
      backlog.oldest_age_seconds,
    );
    const environment = loadEnvironment();
    this.metricsService.recordDeadLetterQueueDepth(
      await this.sqs.getApproximateQueueDepth(environment.SQS_DLQ_QUEUE),
    );
    return this.metricsService.metrics();
  }
}
