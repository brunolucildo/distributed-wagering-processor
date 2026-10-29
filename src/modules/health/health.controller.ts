import { Controller, Get, Logger, Res } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../config/environment";
import { SqsQueueClient } from "../messaging/infrastructure/sqs-queue-client";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsQueueClient,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<{
    status: "ok" | "not_ready";
    dependencies: { database: boolean; sqs: boolean };
  }> {
    const environment = loadEnvironment();
    const [database, sqs] = await Promise.all([
      this.checkDependency("database", async () => {
        await this.orm.em.fork().execute("select 1");
      }),
      this.checkDependency("sqs", () =>
        this.sqs.checkConnectivity([
          environment.SQS_WAGER_QUEUE,
          environment.SQS_DLQ_QUEUE,
          environment.SQS_EVENTS_QUEUE,
        ]),
      ),
    ]);
    const ready = database && sqs;
    response.status(ready ? 200 : 503);
    return {
      status: ready ? "ok" : "not_ready",
      dependencies: { database, sqs },
    };
  }

  private async checkDependency(
    name: string,
    check: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await check();
      return true;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "readiness_dependency_failed",
          dependency: name,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return false;
    }
  }
}
