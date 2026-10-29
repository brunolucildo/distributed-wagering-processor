import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnvironment } from "./config/environment";

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  await app.listen(environment.PORT);
  Logger.log(
    JSON.stringify({
      event: "application_started",
      nodeEnv: environment.NODE_ENV,
      port: environment.PORT,
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
}

void bootstrap();
