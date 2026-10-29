import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "../../src/app.module";
import { WorkerModule } from "../../src/worker.module";
import { loadEnvironment } from "../../src/config/environment";
import { MessagingModule } from "../../src/modules/messaging/messaging.module";
import { OutboxPublisher } from "../../src/modules/messaging/application/outbox-publisher";
import { PendingReferenceReprocessor } from "../../src/modules/messaging/application/pending-reference-reprocessor";
import { SqsWagerConsumer } from "../../src/modules/messaging/application/sqs-wager-consumer";
import { SqsQueueClient } from "../../src/modules/messaging/infrastructure/sqs-queue-client";
import { WagerApplicationService } from "../../src/modules/wagering/application/wager-application-service";
import { PostgresLedgerRepository } from "../../src/modules/ledger/infrastructure/postgres-ledger-repository";
import { PostgresWalletRepository } from "../../src/modules/wallets/infrastructure/postgres-wallet-repository";
import { WalletService } from "../../src/modules/wallets/application/wallet-service";
import { createTestDatabase } from "./database-fixture";

interface ManagedProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  waitForMarker(marker: string, timeoutMs?: number): Promise<void>;
}

function startProcess(
  args: string[],
  environment: NodeJS.ProcessEnv,
): ManagedProcess {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const managed: ManagedProcess = {
    child,
    stdout: "",
    stderr: "",
    async waitForMarker(marker, timeoutMs = 15_000) {
      if (managed.stdout.includes(marker)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timed out waiting for ${marker}. stdout=${managed.stdout} stderr=${managed.stderr}`,
            ),
          );
        }, timeoutMs);
        const onData = (): void => {
          if (!managed.stdout.includes(marker)) return;
          cleanup();
          resolve();
        };
        const onExit = (code: number | null): void => {
          cleanup();
          reject(
            new Error(
              `Process exited with ${code} before ${marker}. stderr=${managed.stderr}`,
            ),
          );
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.on("exit", onExit);
      });
    },
  };
  child.stdout.on("data", (chunk: Buffer) => {
    managed.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    managed.stderr += chunk.toString();
  });
  return managed;
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local TCP port.");
  }
  server.close();
  await once(server, "close");
  return address.port;
}

async function stopProcess(
  managed: ManagedProcess,
  hard = false,
): Promise<void> {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
    return;
  }
  const exit = once(managed.child, "exit");
  managed.child.kill(hard ? "SIGKILL" : "SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    exit.then(() => true),
    new Promise<boolean>(
      (resolve) =>
        (timeout = setTimeout(() => resolve(false), hard ? 5_000 : 15_000)),
    ),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!completed) {
    managed.child.kill("SIGKILL");
    await exit;
  }
}

async function waitForReady(
  managed: ManagedProcess,
  port: number,
  timeoutMs = 20_000,
): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (managed.child.exitCode !== null) {
      throw new Error(`Application exited before readiness: ${managed.stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `Application did not become ready. stdout=${managed.stdout} stderr=${managed.stderr}`,
  );
}

describe.serial("Stage 4 / messaging workers", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: INestApplication;
  let baseUrl: string;
  let wallets: WalletService;
  let wagers: WagerApplicationService;
  let consumer: SqsWagerConsumer;
  let publisher: OutboxPublisher;
  let reprocessor: PendingReferenceReprocessor;
  let sqs: SqsQueueClient;
  let setupClient: SQSClient;
  let queueNames: {
    wager: string;
    deadLetter: string;
    events: string;
    recoveryWager: string;
    recoveryDeadLetter: string;
    recoveryEvents: string;
    redriveWager: string;
    redriveDeadLetter: string;
    processWager: string;
  };
  let queueUrls: string[];
  const runningProcesses: ManagedProcess[] = [];
  let originalEnvironment: Record<string, string | undefined>;
  const environmentKeys = [
    "NODE_ENV",
    "DATABASE_URL",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SQS_ENDPOINT",
    "SQS_WAGER_QUEUE",
    "SQS_DLQ_QUEUE",
    "SQS_EVENTS_QUEUE",
    "WORKER_ROLE",
    "WORKER_HEALTH_PORT",
    "WORKER_SHUTDOWN_TIMEOUT_MS",
    "PORT",
  ];

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.orm.getMigrator().up();
    originalEnvironment = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    const suffix = randomUUID().replaceAll("-", "");
    queueNames = {
      wager: `stage4-wager-${suffix}.fifo`,
      deadLetter: `stage4-dlq-${suffix}.fifo`,
      events: `stage4-events-${suffix}.fifo`,
      recoveryWager: `stage4-recovery-wager-${suffix}.fifo`,
      recoveryDeadLetter: `stage4-recovery-dlq-${suffix}.fifo`,
      recoveryEvents: `stage4-recovery-events-${suffix}.fifo`,
      redriveWager: `stage4-redrive-wager-${suffix}.fifo`,
      redriveDeadLetter: `stage4-redrive-dlq-${suffix}.fifo`,
      processWager: `stage4-process-wager-${suffix}.fifo`,
    };
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = database.url;
    process.env.AWS_REGION = "sa-east-1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.SQS_ENDPOINT = "http://localhost:4566";
    process.env.SQS_WAGER_QUEUE = queueNames.wager;
    process.env.SQS_DLQ_QUEUE = queueNames.deadLetter;
    process.env.SQS_EVENTS_QUEUE = queueNames.events;
    setupClient = new SQSClient({
      region: "sa-east-1",
      endpoint: "http://localhost:4566",
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });
    queueUrls = [];
    const createQueue = async (
      name: string,
      attributes: Record<string, string>,
    ): Promise<{ url: string; arn: string }> => {
      await setupClient.send(
        new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
      );
      const result = await setupClient.send(
        new GetQueueUrlCommand({ QueueName: name }),
      );
      if (!result.QueueUrl) throw new Error(`Queue ${name} has no URL.`);
      const queueAttributes = await setupClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: result.QueueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      if (!queueAttributes.Attributes?.QueueArn) {
        throw new Error(`Queue ${name} has no ARN.`);
      }
      queueUrls.push(result.QueueUrl);
      return { url: result.QueueUrl, arn: queueAttributes.Attributes.QueueArn };
    };
    const deadLetterQueue = await createQueue(queueNames.deadLetter, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    });
    await createQueue(queueNames.wager, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterQueue.arn,
        maxReceiveCount: "5",
      }),
    });
    await createQueue(queueNames.events, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    });
    const recoveryDeadLetterQueue = await createQueue(
      queueNames.recoveryDeadLetter,
      {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    );
    await createQueue(queueNames.recoveryWager, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: recoveryDeadLetterQueue.arn,
        maxReceiveCount: "5",
      }),
    });
    await createQueue(queueNames.recoveryEvents, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    });
    const redriveDeadLetterQueue = await createQueue(
      queueNames.redriveDeadLetter,
      {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    );
    await createQueue(queueNames.redriveWager, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: redriveDeadLetterQueue.arn,
        maxReceiveCount: "5",
      }),
    });
    await createQueue(queueNames.processWager, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: "60",
    });
    expect(loadEnvironment().SQS_WAGER_QUEUE).toBe(queueNames.wager);
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    wallets = new WalletService(
      new PostgresWalletRepository(database.orm),
      new PostgresLedgerRepository(database.orm),
    );
    wagers = app.get(WagerApplicationService);
    const messaging = app.select(MessagingModule);
    sqs = messaging.get(SqsQueueClient);
    const receive = sqs.receive.bind(sqs);
    sqs.receive = (
      queueName,
      maximumMessages,
      visibilityTimeoutSeconds = 60,
      waitTimeSeconds = 0,
    ) =>
      receive(
        queueName,
        maximumMessages,
        visibilityTimeoutSeconds,
        waitTimeSeconds,
      );
    consumer = new SqsWagerConsumer(app.get(MikroORM), wagers, sqs);
    publisher = new OutboxPublisher(app.get(MikroORM), sqs);
    reprocessor = app.get(PendingReferenceReprocessor);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    await Promise.all(
      runningProcesses.map((managed) => stopProcess(managed, true)),
    );
    await app?.close();
    for (const queueUrl of queueUrls ?? []) {
      await setupClient?.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    await setupClient?.destroy();
    if (originalEnvironment) {
      for (const key of environmentKeys) {
        const value = originalEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    await database?.close();
  }, 30_000);

  const createWallet = (openingBalance = "0.00") =>
    wallets.create({
      playerId: randomUUID(),
      currency: "BRL",
      openingBalance,
    });

  function wagerEnvelope(
    walletId: string,
    playerId: string,
    overrides: Partial<{
      messageId: string;
      externalTransactionId: string;
      kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
      amount: string;
      referenceExternalTransactionId: string;
      idempotencyKey: string;
    }> = {},
  ) {
    return {
      messageId: overrides.messageId ?? randomUUID(),
      type: "WagerTransactionRequested" as const,
      version: 1 as const,
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "stage4-provider",
        externalTransactionId: overrides.externalTransactionId ?? randomUUID(),
        playerId,
        walletId,
        roundId: "stage4-round",
        gameId: "stage4-game",
        kind: overrides.kind ?? ("BET" as const),
        money: { amount: overrides.amount ?? "5.00", currency: "BRL" },
        ...(overrides.referenceExternalTransactionId
          ? {
              referenceExternalTransactionId:
                overrides.referenceExternalTransactionId,
            }
          : {}),
        idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      },
    };
  }

  const send = (
    body: string,
    walletId: string,
    deduplicationKey: string = randomUUID(),
  ) => sqs.sendWager(queueNames.wager, body, walletId, deduplicationKey);

  const execute = <T extends object[] = object[]>(
    sql: string,
    params: unknown[] = [],
  ) => database.orm.em.fork().execute<T>(sql, params);

  const workerEnvironment = (
    role: string,
    port: number,
    additions: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv => ({
    ...process.env,
    WORKER_ROLE: role,
    WORKER_HEALTH_PORT: String(port),
    PORT: String(port),
    ...additions,
  });

  const launch = (
    args: string[],
    environment: NodeJS.ProcessEnv,
  ): ManagedProcess => {
    const managed = startProcess(args, environment);
    runningProcesses.push(managed);
    return managed;
  };

  const queueUrl = async (name: string): Promise<string> => {
    const result = await setupClient.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    if (!result.QueueUrl) throw new Error(`Queue ${name} has no URL.`);
    return result.QueueUrl;
  };

  const receiveRaw = async (url: string) =>
    setupClient.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

  const waitForCondition = async (
    condition: () => Promise<boolean>,
    message: string,
    timeoutMs = 20_000,
  ): Promise<void> => {
    const expiresAt = Date.now() + timeoutMs;
    while (Date.now() < expiresAt) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${message}.`);
  };

  const waitForExit = async (
    managed: ManagedProcess,
    timeoutMs: number,
  ): Promise<void> => {
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
      return;
    }
    const exit = once(managed.child, "exit");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      exit.then(() => true),
      new Promise<boolean>(
        (resolve) => (timeout = setTimeout(() => resolve(false), timeoutMs)),
      ),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited) throw new Error(`Process did not exit within ${timeoutMs}ms.`);
  };

  test("readiness requires both PostgreSQL and SQS connectivity", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      dependencies: { database: true, sqs: true },
    });
    const originalEventsQueue = process.env.SQS_EVENTS_QUEUE;
    process.env.SQS_EVENTS_QUEUE = `missing-${randomUUID()}.fifo`;
    try {
      const unavailable = await fetch(`${baseUrl}/health/ready`);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({
        status: "not_ready",
        dependencies: { database: true, sqs: false },
      });
    } finally {
      if (originalEventsQueue === undefined)
        delete process.env.SQS_EVENTS_QUEUE;
      else process.env.SQS_EVENTS_QUEUE = originalEventsQueue;
    }
  });

  test("worker-only module exposes health without the wager HTTP API", async () => {
    const workerApp = await NestFactory.create(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    await workerApp.listen(0, "127.0.0.1");
    try {
      const workerUrl = await workerApp.getUrl();
      expect((await fetch(`${workerUrl}/health/ready`)).status).toBe(200);
      expect((await fetch(`${workerUrl}/wallets`)).status).toBe(404);
      expect(
        (
          await fetch(`${workerUrl}/wagering/transactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(404);
    } finally {
      await workerApp.close();
    }
  });

  test("API, wager consumer, and outbox publisher run as separate processes", async () => {
    const wallet = await createWallet("100.00");
    const envelope = wagerEnvelope(wallet.id, wallet.playerId, {
      amount: "5.00",
    });
    const apiPort = await allocatePort();
    const consumerPort = await allocatePort();
    const publisherPort = await allocatePort();
    const api = launch(
      [join(process.cwd(), "src", "main.ts")],
      workerEnvironment("api", apiPort),
    );
    const wagerWorker = launch(
      [join(process.cwd(), "src", "main.ts")],
      workerEnvironment("wager-consumer", consumerPort, {
        SQS_WAGER_QUEUE: queueNames.processWager,
      }),
    );
    const outboxWorker = launch(
      [join(process.cwd(), "src", "main.ts")],
      workerEnvironment("outbox-publisher", publisherPort),
    );
    try {
      await Promise.all([
        waitForReady(api, apiPort),
        waitForReady(wagerWorker, consumerPort),
        waitForReady(outboxWorker, publisherPort),
      ]);

      await sqs.sendWager(
        queueNames.processWager,
        JSON.stringify(envelope),
        wallet.id,
        randomUUID(),
      );
      await waitForCondition(async () => {
        const rows = await execute<Array<{ status: string }>>(
          `select status from wager_transactions
             where provider_id = 'stage4-provider'
               and external_transaction_id = ?`,
          [envelope.data.externalTransactionId],
        );
        return rows[0]?.status === "PROCESSED";
      }, "the wager to be processed by the independent consumer");
      await wagerWorker.waitForMarker('"event":"wager_message_acknowledged"');
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("95.00");

      const events = await execute<Array<{ event_id: string }>>(
        `select event_id from outbox_messages
           where payload->'data'->>'externalTransactionId' = ?
             and event_type = 'WagerTransactionProcessed'`,
        [envelope.data.externalTransactionId],
      );
      expect(events).toHaveLength(1);
      await waitForCondition(async () => {
        const rows = await execute<Array<{ status: string }>>(
          `select status from outbox_messages where event_id = ?`,
          [events[0]!.event_id],
        );
        return rows[0]?.status === "PUBLISHED";
      }, "the outbox publisher to publish the committed wager event");

      const eventsUrl = await queueUrl(queueNames.events);
      let publishedEventFound = false;
      for (
        let attempt = 0;
        attempt < 20 && !publishedEventFound;
        attempt += 1
      ) {
        const messages = (await receiveRaw(eventsUrl)).Messages ?? [];
        for (const message of messages) {
          if (!message.Body || !message.ReceiptHandle) continue;
          if (JSON.parse(message.Body).eventId === events[0]!.event_id) {
            publishedEventFound = true;
          }
          await setupClient.send(
            new DeleteMessageCommand({
              QueueUrl: eventsUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      expect(publishedEventFound).toBe(true);
    } finally {
      await Promise.all(
        [api, wagerWorker, outboxWorker].map((managed) => stopProcess(managed)),
      );
    }
  }, 60_000);

  test("a worker killed after commit reprocesses the message without a second financial effect", async () => {
    const wallet = await createWallet("20.00");
    const envelope = wagerEnvelope(wallet.id, wallet.playerId, {
      messageId: randomUUID(),
    });
    await sqs.sendWager(
      queueNames.recoveryWager,
      JSON.stringify(envelope),
      wallet.id,
      randomUUID(),
    );
    const recoveryQueues = {
      SQS_WAGER_QUEUE: queueNames.recoveryWager,
      SQS_DLQ_QUEUE: queueNames.recoveryDeadLetter,
      SQS_EVENTS_QUEUE: queueNames.recoveryEvents,
    };

    const crashWorker = launch(
      [
        join(
          process.cwd(),
          "test",
          "integration",
          "fixtures",
          "messaging-crash-worker.ts",
        ),
        "inbox-before-ack",
      ],
      workerEnvironment("wager-consumer", await allocatePort(), recoveryQueues),
    );
    let restartedWorker: ManagedProcess | undefined;
    try {
      await crashWorker.waitForMarker('"event":"before-ack"');
      const receivedLine = crashWorker.stdout
        .split(/\r?\n/)
        .find((line) => line.includes('"event":"message-received"'));
      expect(receivedLine).toBeTruthy();
      const receiptHandle = /"receiptHandle":"([^"]+)"/.exec(
        receivedLine ?? "",
      )?.[1];
      expect(receiptHandle).toBeTruthy();
      expect(
        await execute<Array<{ status: string }>>(
          `select status from inbox_messages
             where consumer_name = 'wager-sqs-v1' and message_id = ?`,
          [envelope.messageId],
        ),
      ).toEqual([{ status: "COMPLETED" }]);
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("15.00");
      await stopProcess(crashWorker, true);

      await setupClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await queueUrl(queueNames.recoveryWager),
          ReceiptHandle: receiptHandle!,
          VisibilityTimeout: 0,
        }),
      );
      const consumerPort = await allocatePort();
      restartedWorker = launch(
        [join(process.cwd(), "src", "main.ts")],
        workerEnvironment("wager-consumer", consumerPort, recoveryQueues),
      );
      await waitForReady(restartedWorker, consumerPort);
      await restartedWorker.waitForMarker(
        '"event":"wager_message_acknowledged"',
      );
      await waitForCondition(async () => {
        const rows = await execute<Array<{ attempts: number }>>(
          `select attempts from inbox_messages
             where consumer_name = 'wager-sqs-v1' and message_id = ?`,
          [envelope.messageId],
        );
        return rows[0]?.attempts === 2;
      }, "the restarted worker to record the duplicate delivery");
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("15.00");
      expect(
        await execute<Array<{ count: string }>>(
          `select count(*)::text as count from wager_transactions
             where provider_id = 'stage4-provider'
               and external_transaction_id = ?`,
          [envelope.data.externalTransactionId],
        ),
      ).toEqual([{ count: "1" }]);
    } finally {
      await Promise.all(
        [crashWorker, restartedWorker]
          .filter((managed): managed is ManagedProcess => managed !== undefined)
          .map((managed) => stopProcess(managed, true)),
      );
    }
  }, 60_000);

  test("an outbox publish accepted before process death is recovered idempotently", async () => {
    await execute(
      `update outbox_messages
         set status = 'PUBLISHED', published_at = coalesce(published_at, now()),
             lease_owner = null, lease_expires_at = null
         where status in ('PENDING', 'PROCESSING')`,
    );
    const eventId = randomUUID();
    await execute(
      `insert into outbox_messages
          (event_id, event_type, aggregate_id, payload, status, attempts,
           next_attempt_at, created_at)
         values (?, 'CrashRecoveryEvent', ?, ?::jsonb, 'PENDING', 0, now(), now())`,
      [
        eventId,
        randomUUID(),
        JSON.stringify({ eventId, eventType: "CrashRecoveryEvent" }),
      ],
    );

    const crashPublisher = launch(
      [
        join(
          process.cwd(),
          "test",
          "integration",
          "fixtures",
          "messaging-crash-worker.ts",
        ),
        "outbox-after-publish",
      ],
      workerEnvironment("outbox-publisher", await allocatePort()),
    );
    await crashPublisher.waitForMarker('"event":"after-publish"');
    expect(
      await execute<Array<{ status: string }>>(
        `select status from outbox_messages where event_id = ?`,
        [eventId],
      ),
    ).toEqual([{ status: "PROCESSING" }]);
    await stopProcess(crashPublisher, true);

    const eventsUrl = await queueUrl(queueNames.events);
    const accepted = (await receiveRaw(eventsUrl)).Messages ?? [];
    const acceptedEvent = accepted.find(
      (message) => message.Body && JSON.parse(message.Body).eventId === eventId,
    );
    expect(acceptedEvent?.ReceiptHandle).toBeTruthy();
    await setupClient.send(
      new DeleteMessageCommand({
        QueueUrl: eventsUrl,
        ReceiptHandle: acceptedEvent!.ReceiptHandle!,
      }),
    );

    await execute(
      `update outbox_messages
         set lease_expires_at = now() - interval '1 second'
         where event_id = ?`,
      [eventId],
    );
    const restartedPublisher = launch(
      [
        join(
          process.cwd(),
          "test",
          "integration",
          "fixtures",
          "messaging-crash-worker.ts",
        ),
        "outbox-once",
      ],
      workerEnvironment("outbox-publisher", await allocatePort()),
    );
    await restartedPublisher.waitForMarker('"event":"publish-batch-complete"');
    await waitForExit(restartedPublisher, 5_000);
    expect(restartedPublisher.child.exitCode).toBe(0);
    expect(
      await execute<Array<{ status: string }>>(
        `select status from outbox_messages where event_id = ?`,
        [eventId],
      ),
    ).toEqual([{ status: "PUBLISHED" }]);

    const duplicates = (await receiveRaw(eventsUrl)).Messages ?? [];
    const duplicate = duplicates.find(
      (message) => message.Body && JSON.parse(message.Body).eventId === eventId,
    );
    if (duplicate?.ReceiptHandle) {
      await setupClient.send(
        new DeleteMessageCommand({
          QueueUrl: eventsUrl,
          ReceiptHandle: duplicate.ReceiptHandle,
        }),
      );
    }
    expect(duplicate).toBeUndefined();
  }, 60_000);

  test("transient processing failures are redriven to the configured dead-letter queue", async () => {
    const wallet = await createWallet("20.00");
    const externalTransactionId = randomUUID();
    const envelope = wagerEnvelope(wallet.id, wallet.playerId, {
      externalTransactionId,
    });
    await execute(
      `create function stage4_transient_wager_failure()
         returns trigger language plpgsql as $$
         begin
           if new.external_transaction_id = '${externalTransactionId}' then
             raise exception 'injected transient failure' using errcode = '40001';
           end if;
           return new;
         end;
         $$`,
    );
    await execute(
      `create trigger stage4_transient_wager_failure
         before insert on wager_transactions
         for each row execute function stage4_transient_wager_failure()`,
    );
    const originalReceive = sqs.receive.bind(sqs);
    const receiveCounts: number[] = [];
    sqs.receive = async (name, maximumMessages) => {
      const messages = await originalReceive(name, maximumMessages, 0, 0);
      receiveCounts.push(...messages.map((message) => message.receiveCount));
      return messages;
    };
    const originalWagerQueue = process.env.SQS_WAGER_QUEUE;
    const originalDeadLetterQueue = process.env.SQS_DLQ_QUEUE;
    process.env.SQS_WAGER_QUEUE = queueNames.redriveWager;
    process.env.SQS_DLQ_QUEUE = queueNames.redriveDeadLetter;
    const redriveConsumer = new SqsWagerConsumer(
      app.get(MikroORM),
      wagers,
      sqs,
    );
    let failedAttempts = 0;
    const processingErrors: string[] = [];
    let deadLettered: string | undefined;
    try {
      await sqs.sendWager(
        queueNames.redriveWager,
        JSON.stringify(envelope),
        wallet.id,
        randomUUID(),
      );
      const deadLetterUrl = await queueUrl(queueNames.redriveDeadLetter);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await redriveConsumer.pollOnce();
        } catch (error) {
          failedAttempts += 1;
          processingErrors.push(
            error instanceof Error ? error.message : "unknown error",
          );
        }
        const deadLetterMessages =
          (await receiveRaw(deadLetterUrl)).Messages ?? [];
        const deadLetter = deadLetterMessages.find(
          (message) =>
            message.Body &&
            JSON.parse(message.Body).messageId === envelope.messageId,
        );
        if (deadLetter?.ReceiptHandle) {
          deadLettered = deadLetter.Body;
          await setupClient.send(
            new DeleteMessageCommand({
              QueueUrl: deadLetterUrl,
              ReceiptHandle: deadLetter.ReceiptHandle,
            }),
          );
          break;
        }
      }
      if (!deadLettered) {
        const sourceState = await setupClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: await queueUrl(queueNames.redriveWager),
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
              "RedrivePolicy",
            ],
          }),
        );
        throw new Error(
          `Redrive did not occur: failures=${failedAttempts}, receiveCounts=${receiveCounts.join(",")}, errors=${processingErrors.join("|")}, source=${JSON.stringify(sourceState.Attributes)}`,
        );
      }
    } finally {
      sqs.receive = originalReceive;
      if (originalWagerQueue === undefined) delete process.env.SQS_WAGER_QUEUE;
      else process.env.SQS_WAGER_QUEUE = originalWagerQueue;
      if (originalDeadLetterQueue === undefined)
        delete process.env.SQS_DLQ_QUEUE;
      else process.env.SQS_DLQ_QUEUE = originalDeadLetterQueue;
      await execute(
        `drop trigger if exists stage4_transient_wager_failure on wager_transactions`,
      );
      await execute(`drop function if exists stage4_transient_wager_failure()`);
    }
    expect(deadLettered).toBe(JSON.stringify(envelope));
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("20.00");
    expect(
      await execute<Array<{ count: string }>>(
        `select count(*)::text as count from wager_transactions
           where external_transaction_id = ?`,
        [externalTransactionId],
      ),
    ).toEqual([{ count: "0" }]);
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "shutdown timeout exits a worker process and rolls back its in-flight transaction",
    async () => {
      const wallet = await createWallet("20.00");
      const externalTransactionId = randomUUID();
      const envelope = wagerEnvelope(wallet.id, wallet.playerId, {
        externalTransactionId,
      });
      await execute(
        `create function stage4_slow_wager_insert()
         returns trigger language plpgsql as $$
         begin
           if new.external_transaction_id = '${externalTransactionId}' then
             perform pg_sleep(10);
           end if;
           return new;
         end;
         $$`,
      );
      await execute(
        `create trigger stage4_slow_wager_insert
         before insert on wager_transactions
         for each row execute function stage4_slow_wager_insert()`,
      );
      const port = await allocatePort();
      const worker = launch(
        [join(process.cwd(), "src", "main.ts")],
        workerEnvironment("wager-consumer", port, {
          WORKER_SHUTDOWN_TIMEOUT_MS: "100",
        }),
      );
      try {
        await waitForReady(worker, port);
        await send(JSON.stringify(envelope), wallet.id);
        await waitForCondition(
          async () => {
            const rows = await execute<Array<{ count: string }>>(
              `select count(*)::text as count from pg_stat_activity
             where datname = current_database() and wait_event = 'PgSleep'`,
            );
            return rows[0]?.count !== "0";
          },
          "the consumer to enter the injected database delay",
          15_000,
        );
        worker.child.kill("SIGTERM");
        await waitForExit(worker, 5_000);
        expect(worker.child.exitCode).toBe(1);
        expect(`${worker.stdout}\n${worker.stderr}`).toContain(
          "worker_shutdown_timeout",
        );
      } finally {
        await stopProcess(worker, true);
        await execute(
          `drop trigger if exists stage4_slow_wager_insert on wager_transactions`,
        );
        await execute(`drop function if exists stage4_slow_wager_insert()`);
      }
      expect((await wallets.get(wallet.id)).balance.toString()).toBe("20.00");
      expect(
        await execute<Array<{ count: string }>>(
          `select count(*)::text as count from wager_transactions
           where external_transaction_id = ?`,
          [externalTransactionId],
        ),
      ).toEqual([{ count: "0" }]);
    },
    60_000,
  );

  test("two publisher processes claim disjoint batches concurrently", async () => {
    await execute(
      `update outbox_messages
         set status = 'PUBLISHED', published_at = coalesce(published_at, now()),
             lease_owner = null, lease_expires_at = null
         where status in ('PENDING', 'PROCESSING')`,
    );
    const eventIds = Array.from({ length: 20 }, () => randomUUID());
    for (const eventId of eventIds) {
      await execute(
        `insert into outbox_messages
            (event_id, event_type, aggregate_id, payload, status, attempts,
             next_attempt_at, created_at)
           values (?, 'ProcessClaimEvent', ?, ?::jsonb, 'PENDING', 0, now(), now())`,
        [
          eventId,
          randomUUID(),
          JSON.stringify({ eventId, eventType: "ProcessClaimEvent" }),
        ],
      );
    }

    const fixturePath = join(
      process.cwd(),
      "test",
      "integration",
      "fixtures",
      "messaging-crash-worker.ts",
    );
    const firstPublisher = launch(
      [fixturePath, "outbox-after-claim"],
      workerEnvironment("outbox-publisher", await allocatePort()),
    );
    const secondPublisher = launch(
      [fixturePath, "outbox-after-claim"],
      workerEnvironment("outbox-publisher", await allocatePort()),
    );
    try {
      await firstPublisher.waitForMarker('"event":"after-claim"');
      await secondPublisher.waitForMarker('"event":"after-claim"');
      const eventPlaceholders = eventIds.map(() => "?").join(", ");
      const claims = await execute<
        Array<{ lease_owner: string; count: number }>
      >(
        `select lease_owner, count(*)::int as count
           from outbox_messages
           where event_id in (${eventPlaceholders}) and status = 'PROCESSING'
           group by lease_owner`,
        eventIds,
      );
      expect(claims).toHaveLength(2);
      expect(claims.map((claim) => claim.count).sort()).toEqual([10, 10]);
      expect(new Set(claims.map((claim) => claim.lease_owner)).size).toBe(2);
    } finally {
      await Promise.all([
        stopProcess(firstPublisher, true),
        stopProcess(secondPublisher, true),
      ]);
      const eventPlaceholders = eventIds.map(() => "?").join(", ");
      await execute(
        `update outbox_messages
           set status = 'PUBLISHED', published_at = now(),
               lease_owner = null, lease_expires_at = null
           where event_id in (${eventPlaceholders})`,
        eventIds,
      );
    }
  }, 60_000);

  test("Inbox makes duplicate delivery idempotent and dead-letters conflicting payloads", async () => {
    const wallet = await createWallet("20.00");
    const messageId = "stage4-stable-message-id";
    const original = wagerEnvelope(wallet.id, wallet.playerId, { messageId });
    const conflict = wagerEnvelope(wallet.id, wallet.playerId, {
      messageId,
      externalTransactionId: "different-external-transaction",
    });
    await send(JSON.stringify(original), wallet.id, "dedup-original");
    await send(JSON.stringify(original), wallet.id, "dedup-duplicate");
    await consumer.pollOnce();
    await consumer.pollOnce();
    const inbox = await execute<Array<{ attempts: number; status: string }>>(
      `select attempts, status from inbox_messages
       where consumer_name = 'wager-sqs-v1' and message_id = ?`,
      [messageId],
    );
    expect(inbox).toEqual([{ attempts: 2, status: "COMPLETED" }]);
    expect(
      await execute<{ count: string }[]>(
        `select count(*)::text as count from wager_transactions
         where provider_id = 'stage4-provider'
           and external_transaction_id = ?`,
        [original.data.externalTransactionId],
      ),
    ).toEqual([{ count: "1" }]);
    await send(
      JSON.stringify(conflict),
      wallet.id,
      "dedup-conflicting-payload",
    );
    await consumer.pollOnce();
    expect(
      await execute<{ count: string }[]>(
        `select count(*)::text as count from inbox_message_conflicts
         where consumer_name = 'wager-sqs-v1' and message_id = ?`,
        [messageId],
      ),
    ).toEqual([{ count: "1" }]);
    const deadLetter = await sqs.receive(queueNames.deadLetter, 10);
    expect(deadLetter).toHaveLength(1);
    expect(JSON.parse(deadLetter[0]!.body)).toEqual(conflict);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("15.00");
  });

  test("Outbox publisher leases and publishes durable events", async () => {
    const eventId = randomUUID();
    await execute(
      `insert into outbox_messages
        (event_id, event_type, aggregate_id, payload, status, attempts,
         next_attempt_at, created_at)
       values (?, 'TestEvent', ?, ?::jsonb, 'PENDING', 0, now(), now())`,
      [
        eventId,
        randomUUID(),
        JSON.stringify({ eventId, eventType: "TestEvent" }),
      ],
    );
    expect(await publisher.publishBatch()).toBeGreaterThan(0);
    expect(
      await execute<Array<{ status: string; attempts: number }>>(
        `select status, attempts from outbox_messages where event_id = ?`,
        [eventId],
      ),
    ).toEqual([{ status: "PUBLISHED", attempts: 0 }]);
    const publishedMessages = await sqs.receive(queueNames.events, 10);
    expect(
      publishedMessages.some(
        (message) => JSON.parse(message.body).eventId === eventId,
      ),
    ).toBe(true);
  });

  test("two publishers claim disjoint batches and failed rows can be replayed", async () => {
    const eventIds = Array.from({ length: 12 }, () => randomUUID());
    for (const eventId of eventIds) {
      await execute(
        `insert into outbox_messages
          (event_id, event_type, aggregate_id, payload, status, attempts,
           next_attempt_at, created_at)
         values (?, 'ConcurrentEvent', ?, ?::jsonb, 'PENDING', 0, now(), now())`,
        [
          eventId,
          randomUUID(),
          JSON.stringify({ eventId, eventType: "ConcurrentEvent" }),
        ],
      );
    }
    const secondPublisher = new OutboxPublisher(app.get(MikroORM), sqs);
    await Promise.all([
      publisher.publishBatch(),
      secondPublisher.publishBatch(),
    ]);
    const eventPlaceholders = eventIds.map(() => "?").join(", ");
    const unpublishedCount = async () =>
      execute<Array<{ count: string }>>(
        `select count(*)::text as count from outbox_messages
         where event_id in (${eventPlaceholders}) and status <> 'PUBLISHED'`,
        eventIds,
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await unpublishedCount();
      if (state[0]?.count === "0") break;
      await publisher.publishBatch();
      await secondPublisher.publishBatch();
    }
    expect(await unpublishedCount()).toEqual([{ count: "0" }]);

    const failedEventId = randomUUID();
    await execute(
      `insert into outbox_messages
        (event_id, event_type, aggregate_id, payload, status, attempts,
         next_attempt_at, created_at, last_error)
       values (?, 'FailedEvent', ?, ?::jsonb, 'FAILED', 10, now(), now(), 'SendError')`,
      [
        failedEventId,
        randomUUID(),
        JSON.stringify({ eventId: failedEventId, eventType: "FailedEvent" }),
      ],
    );
    expect(await publisher.replayFailed(failedEventId)).toBe(true);
    expect(
      await execute<
        Array<{ status: string; attempts: number; last_error: string | null }>
      >(
        `select status, attempts, last_error from outbox_messages
         where event_id = ?`,
        [failedEventId],
      ),
    ).toEqual([{ status: "PENDING", attempts: 0, last_error: null }]);
  });

  test("Outbox publication failures are retained and scheduled for retry", async () => {
    const eventId = randomUUID();
    const originalEventsQueue = process.env.SQS_EVENTS_QUEUE;
    await execute(
      `insert into outbox_messages
        (event_id, event_type, aggregate_id, payload, status, attempts,
         next_attempt_at, created_at)
       values (?, 'RetryEvent', ?, ?::jsonb, 'PENDING', 0, now(), now())`,
      [
        eventId,
        randomUUID(),
        JSON.stringify({ eventId, eventType: "RetryEvent" }),
      ],
    );
    process.env.SQS_EVENTS_QUEUE = `missing-${randomUUID()}.fifo`;
    const failingSqs = new SqsQueueClient();
    try {
      const failingPublisher = new OutboxPublisher(
        app.get(MikroORM),
        failingSqs,
      );
      expect(await failingPublisher.publishBatch()).toBeGreaterThanOrEqual(1);
    } finally {
      await failingSqs.close();
      if (originalEventsQueue === undefined)
        delete process.env.SQS_EVENTS_QUEUE;
      else process.env.SQS_EVENTS_QUEUE = originalEventsQueue;
    }
    const rows = await execute<
      Array<{ status: string; attempts: number; last_error: string | null }>
    >(
      `select status, attempts, last_error from outbox_messages
       where event_id = ?`,
      [eventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
    expect(rows[0]?.last_error).toBeTruthy();
  });

  test("pending references recover through persisted reprocessing after resolution", async () => {
    const wallet = await createWallet("100.00");
    const referenceExternalTransactionId = "stage4-reference-bet";
    const pending = await wagers.submit(
      {
        providerId: "stage4-provider",
        externalTransactionId: "stage4-pending-win",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "stage4-round",
        gameId: "stage4-game",
        kind: "WIN",
        money: { amount: "5.00", currency: "BRL" },
        referenceExternalTransactionId,
      },
      "stage4-pending-idempotency",
    );
    expect(pending.body.status).toBe("PENDING_REFERENCE");
    await wagers.submit(
      {
        providerId: "stage4-provider",
        externalTransactionId: referenceExternalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "stage4-round",
        gameId: "stage4-game",
        kind: "BET",
        money: { amount: "5.00", currency: "BRL" },
      },
      "stage4-reference-idempotency",
    );
    await execute(
      `update wager_transactions set next_retry_at = now()
       where external_transaction_id = 'stage4-pending-win'`,
    );
    expect(await reprocessor.reprocessBatch()).toBe(1);
    const rows = await execute<Array<{ status: string; retry_count: number }>>(
      `select status, retry_count from wager_transactions
       where external_transaction_id = 'stage4-pending-win'`,
    );
    expect(rows).toEqual([{ status: "PROCESSED", retry_count: 1 }]);
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("100.00");
  });

  test("pending references expire after the retry limit with an atomic rejection event", async () => {
    const wallet = await createWallet("20.00");
    const pending = await wagers.submit(
      {
        providerId: "stage4-provider",
        externalTransactionId: "stage4-expiring-win",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "stage4-round",
        gameId: "stage4-game",
        kind: "WIN",
        money: { amount: "5.00", currency: "BRL" },
        referenceExternalTransactionId: "stage4-never-arrives",
      },
      "stage4-expiring-idempotency",
    );
    await execute(
      `update wager_transactions
       set retry_count = 19, next_retry_at = now()
       where id = ?`,
      [pending.body.transactionId],
    );
    expect(await reprocessor.reprocessBatch()).toBe(1);
    expect(
      await execute<
        Array<{ status: string; failure_code: string; retry_count: number }>
      >(
        `select status, failure_code, retry_count from wager_transactions
         where id = ?`,
        [pending.body.transactionId],
      ),
    ).toEqual([
      {
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_FOUND",
        retry_count: 20,
      },
    ]);
    expect(
      await execute<Array<{ event_type: string }>>(
        `select event_type from outbox_messages
         where payload->'data'->>'transactionId' = ?`,
        [pending.body.transactionId],
      ),
    ).toContainEqual({ event_type: "WagerTransactionRejected" });
    expect((await wallets.get(wallet.id)).balance.toString()).toBe("20.00");
  });
});
