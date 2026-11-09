import type { LoggerService } from "@nestjs/common";
import { currentCorrelationId } from "./correlation-context";

type Level = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";

type Sink = (line: string) => void;

/**
 * Emits exactly one JSON object per line. Application code already logs
 * structured JSON strings; those fields are merged into the entry, and the
 * ambient correlation ID is attached when the call did not set one.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly stdout: Sink = (line) => process.stdout.write(line),
    private readonly stderr: Sink = (line) => process.stderr.write(line),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  private write(
    level: Level,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const strings = optionalParams.filter(
      (value): value is string => typeof value === "string",
    );
    const context = strings.at(-1);
    const fields = this.fields(message);
    const entry = {
      timestamp: this.clock().toISOString(),
      level,
      ...(context ? { context } : {}),
      correlationId: currentCorrelationId(),
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    (level === "error" || level === "fatal" ? this.stderr : this.stdout)(line);
  }

  private fields(message: unknown): Record<string, unknown> {
    if (typeof message === "string") {
      const trimmed = message.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      return { message };
    }
    if (message instanceof Error) {
      return { message: message.message, errorType: message.name };
    }
    return { message: String(message) };
  }
}
