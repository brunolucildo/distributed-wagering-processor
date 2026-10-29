export const DomainFailureCode = {
  INVALID_TRANSACTION: "INVALID_TRANSACTION",
  PERMANENT_PROCESSING_FAILURE: "PERMANENT_PROCESSING_FAILURE",
  WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
  WALLET_MISMATCH: "WALLET_MISMATCH",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  REFERENCE_NOT_FOUND: "REFERENCE_NOT_FOUND",
  REFERENCE_INVALID: "REFERENCE_INVALID",
  REFERENCE_ALREADY_REVERSED: "REFERENCE_ALREADY_REVERSED",
  REVERSAL_AMOUNT_MISMATCH: "REVERSAL_AMOUNT_MISMATCH",
  REVERSAL_WOULD_OVERDRAW: "REVERSAL_WOULD_OVERDRAW",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
} as const;

export type DomainFailureCode =
  (typeof DomainFailureCode)[keyof typeof DomainFailureCode];

export class DomainError extends Error {
  constructor(
    public readonly code: DomainFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function invalidTransaction(message: string): never {
  throw new DomainError(DomainFailureCode.INVALID_TRANSACTION, message);
}
