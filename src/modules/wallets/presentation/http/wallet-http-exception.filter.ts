import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { DriverException } from "@mikro-orm/core";
import { ZodError } from "zod";
import {
  InvalidWalletRequestError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/wallet-errors";
import { DomainError } from "../../domain/errors/domain-error";
import {
  WagerConflictError,
  WagerNotFoundError,
  WagerPersistenceUnavailableError,
} from "../../../wagering/application/wager-errors";

@Catch()
export class WalletHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WalletHttpExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    let status: number;
    let code: string;
    let message: string;
    if (error instanceof WalletAlreadyExistsError) {
      status = 409;
      code = "WALLET_ALREADY_EXISTS";
      message = error.message;
    } else if (error instanceof WagerConflictError) {
      status = 409;
      code = "IDEMPOTENCY_CONFLICT";
      message = error.message;
    } else if (
      error instanceof WalletNotFoundError ||
      error instanceof WagerNotFoundError
    ) {
      status = 404;
      code =
        error instanceof WalletNotFoundError
          ? "WALLET_NOT_FOUND"
          : "WAGER_NOT_FOUND";
      message = error.message;
    } else if (error instanceof WagerPersistenceUnavailableError) {
      status = 503;
      code = "PERSISTENCE_UNAVAILABLE";
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = "INVALID_REQUEST";
      message = "Request fields do not match the wallet contract.";
    } else if (
      error instanceof InvalidWalletRequestError ||
      error instanceof DomainError
    ) {
      status = 400;
      code = error instanceof DomainError ? error.code : "INVALID_REQUEST";
      message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? "INVALID_REQUEST" : "HTTP_ERROR";
      message = status === 400 ? "Invalid request." : error.message;
    } else {
      status = error instanceof DriverException ? 503 : 500;
      code = status === 503 ? "PERSISTENCE_UNAVAILABLE" : "INTERNAL_ERROR";
      message =
        status === 503
          ? "Persistence is unavailable. Retry the request."
          : "An unexpected error occurred.";
      this.logger.error(
        JSON.stringify({
          event: "wallet_request_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
          ...(error instanceof DriverException
            ? {
                code: error.code,
                ...("constraint" in error &&
                typeof error.constraint === "string"
                  ? { constraint: error.constraint }
                  : {}),
              }
            : {}),
          status,
        }),
      );
    }
    host
      .switchToHttp()
      .getResponse<{
        status(value: number): {
          json(body: { code: string; message: string }): void;
        };
      }>()
      .status(status)
      .json({ code, message });
  }
}
