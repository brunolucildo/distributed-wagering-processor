import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://wagering:wagering_local@localhost:5432/wagering"),
  AWS_REGION: z.string().min(1).default("sa-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SQS_ENDPOINT: z.string().url().nullable().default(null),
  SQS_WAGER_QUEUE: z.string().min(1).default("wager-transactions.fifo"),
  SQS_DLQ_QUEUE: z.string().min(1).default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE: z.string().min(1).default("integration-events.fifo"),
  WORKER_ROLE: z
    .enum([
      "api",
      "wager-consumer",
      "outbox-publisher",
      "reference-reprocessor",
      "all",
    ])
    .default("api"),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
});

export type AppEnvironment = z.infer<typeof EnvironmentSchema>;

const productionRequiredVariables = [
  "DATABASE_URL",
  "AWS_REGION",
  "SQS_WAGER_QUEUE",
  "SQS_DLQ_QUEUE",
  "SQS_EVENTS_QUEUE",
] as const;

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  const environment = EnvironmentSchema.parse(source);

  if (environment.NODE_ENV === "production") {
    const missingVariables = productionRequiredVariables.filter(
      (key) => !source[key],
    );

    if (missingVariables.length > 0) {
      throw new Error(
        `Missing required production environment variables: ${missingVariables.join(", ")}`,
      );
    }
  }

  return {
    ...environment,
    SQS_ENDPOINT:
      environment.SQS_ENDPOINT ??
      (environment.NODE_ENV === "production" ? null : "http://localhost:4566"),
  };
}
