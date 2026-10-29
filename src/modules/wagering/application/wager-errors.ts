export class WagerConflictError extends Error {
  constructor() {
    super(
      "The transaction identity or idempotency key conflicts with an existing request.",
    );
    this.name = "WagerConflictError";
  }
}

export class WagerNotFoundError extends Error {
  constructor() {
    super("Wager transaction not found.");
    this.name = "WagerNotFoundError";
  }
}

export class WagerPersistenceUnavailableError extends Error {
  constructor() {
    super(
      "Persistence is temporarily unavailable. Retry with the same idempotency key.",
    );
    this.name = "WagerPersistenceUnavailableError";
  }
}

export interface WagerSubmissionBody {
  transactionId: string;
  status: string;
  failureCode?: string;
  walletBalance: string;
  idempotentReplay: boolean;
}

export interface WagerSubmissionResult {
  httpStatus: 200 | 202 | 422;
  body: WagerSubmissionBody;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  status: string;
  failureCode: string | null;
  walletBalance: string | null;
  createdAt: string;
  completedAt: string | null;
}
