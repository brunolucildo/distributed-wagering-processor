import { describe, expect, test } from "bun:test";
import { loadEnvironment } from "../src/config/environment";

describe("environment configuration", () => {
  test("provides safe local development defaults", () => {
    const environment = loadEnvironment({ NODE_ENV: "development" });

    expect(environment.PORT).toBe(3000);
    expect(environment.WORKER_HEALTH_PORT).toBe(3001);
    expect(environment.DATABASE_URL).toBe(
      "postgresql://wagering:wagering_local@localhost:5432/wagering",
    );
    expect(environment.SQS_ENDPOINT).toBe("http://localhost:4566");
  });

  test("rejects production configuration that relies on local defaults", () => {
    expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow(
      "Missing required production environment variables",
    );
  });

  test("does not default production SQS to the local emulator", () => {
    const environment = loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@db.example.com/wagering",
      AWS_REGION: "sa-east-1",
      SQS_WAGER_QUEUE: "wagers",
      SQS_DLQ_QUEUE: "wagers-dlq",
      SQS_EVENTS_QUEUE: "events",
    });

    expect(environment.SQS_ENDPOINT).toBeNull();
  });

  test("rejects an invalid port", () => {
    expect(() =>
      loadEnvironment({ NODE_ENV: "development", PORT: "70000" }),
    ).toThrow();
  });

  test("rejects an invalid worker health port", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        WORKER_HEALTH_PORT: "70000",
      }),
    ).toThrow();
  });
});
