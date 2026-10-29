import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { HealthController } from "../src/modules/health/health.controller";
import { SqsQueueClient } from "../src/modules/messaging/infrastructure/sqs-queue-client";

describe("health endpoint", () => {
  const dependencies = { database: true, sqs: true };
  const orm = {
    em: {
      fork: () => ({
        execute: async () => {
          if (!dependencies.database) throw new Error("database unavailable");
        },
      }),
    },
  };
  const sqs = {
    checkConnectivity: async () => {
      if (!dependencies.sqs) throw new Error("sqs unavailable");
    },
  };
  @Module({
    controllers: [HealthController],
    providers: [
      { provide: MikroORM, useValue: orm },
      { provide: SqsQueueClient, useValue: sqs },
    ],
  })
  class HealthTestModule {}

  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(HealthTestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test("reports process liveness", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("readiness reports a failed required dependency", async () => {
    dependencies.sqs = false;
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "not_ready",
        dependencies: { database: true, sqs: false },
      });
    } finally {
      dependencies.sqs = true;
    }
  });
});
