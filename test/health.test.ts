import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { HealthModule } from "../src/modules/health/health.module";

describe("health endpoint", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(HealthModule, { logger: false });
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
});
