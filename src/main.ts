import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnvironment } from "./config/environment";
import { WorkerModule } from "./worker.module";
import { OutboxPublisher } from "./modules/messaging/application/outbox-publisher";
import { PendingReferenceReprocessor } from "./modules/messaging/application/pending-reference-reprocessor";
import { SqsWagerConsumer } from "./modules/messaging/application/sqs-wager-consumer";

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const servesApi =
    environment.WORKER_ROLE === "api" || environment.WORKER_ROLE === "all";
  const app = await NestFactory.create(servesApi ? AppModule : WorkerModule);
  const consumer = app.get(SqsWagerConsumer);
  const publisher = app.get(OutboxPublisher);
  const reprocessor = app.get(PendingReferenceReprocessor);
  const workers: Array<() => Promise<void>> = [];

  if (
    environment.WORKER_ROLE === "wager-consumer" ||
    environment.WORKER_ROLE === "all"
  ) {
    workers.push(() => consumer.run());
  }
  if (
    environment.WORKER_ROLE === "outbox-publisher" ||
    environment.WORKER_ROLE === "all"
  ) {
    workers.push(() => publisher.run());
  }
  if (
    environment.WORKER_ROLE === "reference-reprocessor" ||
    environment.WORKER_ROLE === "all"
  ) {
    workers.push(() => reprocessor.run());
  }

  if (servesApi) {
    await app.listen(environment.PORT);
  } else {
    await app.listen(environment.WORKER_HEALTH_PORT);
  }
  Logger.log(
    JSON.stringify({
      event: "application_started",
      nodeEnv: environment.NODE_ENV,
      port: servesApi ? environment.PORT : environment.WORKER_HEALTH_PORT,
      workerRole: environment.WORKER_ROLE,
      databaseConfigured: Boolean(environment.DATABASE_URL),
      sqsEndpointConfigured: Boolean(environment.SQS_ENDPOINT),
      sqsRegion: environment.AWS_REGION,
      queues: {
        wager: environment.SQS_WAGER_QUEUE,
        deadLetter: environment.SQS_DLQ_QUEUE,
        events: environment.SQS_EVENTS_QUEUE,
      },
    }),
    "Bootstrap",
  );
  if (workers.length === 0) {
    app.enableShutdownHooks();
    return;
  }

  const stopWorkers = (): void => {
    consumer.stop();
    publisher.stop();
    reprocessor.stop();
  };
  let resolveShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const workerCompletion = Promise.all(workers.map((start) => start()))
    .catch((error: unknown) => {
      Logger.error(
        JSON.stringify({
          event: "worker_loop_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
        undefined,
        "Bootstrap",
      );
      process.exitCode = 1;
      stopWorkers();
    })
    .finally(resolveShutdown);
  const shutdown = (): void => {
    stopWorkers();
    resolveShutdown();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await shutdownRequested;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const shutdownCompleted = await Promise.race([
    workerCompletion.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(
        () => resolve(false),
        environment.WORKER_SHUTDOWN_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!shutdownCompleted) {
    process.exitCode = 1;
    Logger.error(
      JSON.stringify({
        event: "worker_shutdown_timeout",
        timeoutMs: environment.WORKER_SHUTDOWN_TIMEOUT_MS,
      }),
      undefined,
      "Bootstrap",
    );
    await new Promise<void>((resolve) =>
      process.stderr.write("", () => resolve()),
    );
    process.exit(1);
  }
  await app.close();
}

void bootstrap();
