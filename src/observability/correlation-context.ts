import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import { z } from "zod";

const CorrelationIdSchema = z.string().uuid();
const correlationStorage = new AsyncLocalStorage<string>();

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function runWithCorrelation<T>(
  correlationId: string,
  operation: () => T,
): T {
  return correlationStorage.run(correlationId, operation);
}

export function validCorrelationId(value: unknown): string | undefined {
  const parsed = CorrelationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function correlationIdFromPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return validCorrelationId((value as Record<string, unknown>).correlationId);
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(
    request: { get(name: string): string | undefined },
    response: { setHeader(name: string, value: string): unknown },
    next: () => void,
  ): void {
    const requestId = validCorrelationId(request.get("x-correlation-id"));
    const correlationId = requestId ?? randomUUID();
    response.setHeader("x-correlation-id", correlationId);
    runWithCorrelation(correlationId, next);
  }
}
