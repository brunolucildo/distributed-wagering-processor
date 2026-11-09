import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../../src/observability/json-logger";
import { runWithCorrelation } from "../../src/observability/correlation-context";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logger = new JsonLogger(
    (line) => out.push(line),
    (line) => err.push(line),
    () => new Date("2026-10-30T12:00:00.000Z"),
  );
  return { logger, out, err };
}

describe("JsonLogger", () => {
  test("writes one parseable JSON object per line", () => {
    const { logger, out } = capture();
    logger.log("plain text", "Bootstrap");
    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      timestamp: "2026-10-30T12:00:00.000Z",
      level: "log",
      context: "Bootstrap",
      message: "plain text",
    });
  });

  test("merges structured JSON messages into the entry", () => {
    const { logger, out } = capture();
    logger.warn(
      JSON.stringify({
        event: "wager_message_dead_lettered",
        messageId: "msg-1",
        walletId: "wallet-1",
      }),
      "SqsWagerConsumer",
    );
    expect(JSON.parse(out[0] ?? "")).toMatchObject({
      level: "warn",
      context: "SqsWagerConsumer",
      event: "wager_message_dead_lettered",
      messageId: "msg-1",
      walletId: "wallet-1",
    });
  });

  test("attaches the ambient correlation ID unless the message sets one", () => {
    const { logger, out } = capture();
    runWithCorrelation("11111111-1111-4111-8111-111111111111", () => {
      logger.log(JSON.stringify({ event: "ambient" }));
      logger.log(
        JSON.stringify({
          event: "explicit",
          correlationId: "22222222-2222-4222-8222-222222222222",
        }),
      );
    });
    expect(JSON.parse(out[0] ?? "").correlationId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(JSON.parse(out[1] ?? "").correlationId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  test("routes errors to stderr and keeps the stack out of the entry", () => {
    const { logger, out, err } = capture();
    logger.error("boom", "stack trace line", "Ctx");
    expect(out).toHaveLength(0);
    const entry = JSON.parse(err[0] ?? "");
    expect(entry).toMatchObject({ level: "error", context: "Ctx" });
    expect(JSON.stringify(entry)).not.toContain("stack trace line");
  });
});
