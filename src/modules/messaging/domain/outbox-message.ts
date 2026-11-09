import type { IntegrationEvent } from "../contracts/integration-events";

/** Publication attempts before an event stays FAILED until explicit replay. */
export const OUTBOX_MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Captures an integration event to be committed with the financial change. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload: unknown = JSON.parse(JSON.stringify(event));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Integration event must serialize to a JSON object.");
    }
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  /** Rebuilds persisted state without re-evaluating transitions. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** True once every allowed publication attempt has failed. */
  isExhausted(): boolean {
    return this.isPending() && this._attempts >= OUTBOX_MAX_ATTEMPTS;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      !this.isExhausted() &&
      (this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error("Outbox message was already published.");
    }
    this._publishedAt = at;
  }

  /**
   * Counts a failed publication and schedules the next one with exponential
   * backoff (1s base, 5min cap) and +/-50% jitter. `random` is injectable so
   * the schedule is deterministic in tests.
   */
  scheduleRetry(now: Date, random: () => number = Math.random): void {
    if (!this.isPending()) {
      throw new Error("A published Outbox message cannot be retried.");
    }
    this._attempts += 1;
    const base = Math.min(
      BASE_DELAY_MS * 2 ** (this._attempts - 1),
      MAX_DELAY_MS,
    );
    const delay = Math.min(MAX_DELAY_MS, Math.round(base * (0.5 + random())));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
