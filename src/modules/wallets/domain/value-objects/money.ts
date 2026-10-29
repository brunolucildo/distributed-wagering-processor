import { DomainError, DomainFailureCode } from "../errors/domain-error";

const SPECIAL_ISO_CURRENCIES = new Set([
  "XAU",
  "XAG",
  "XPD",
  "XPT",
  "XDR",
  "XTS",
  "XXX",
  "XBA",
  "XBB",
  "XBC",
  "XBD",
  "XSU",
  "XUA",
  "XFU",
]);

const runtimeCurrencyCodes = Intl.supportedValuesOf("currency");

const ISO_CURRENCY_CODES = new Set([
  ...runtimeCurrencyCodes,
  ...SPECIAL_ISO_CURRENCIES,
]);

/**
 * An exact, two-decimal monetary value stored as integer minor units.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static parse(amount: string, currency: string): Money {
    this.assertCurrency(currency);
    if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Amount must be a non-negative decimal string with exactly two fractional digits.",
      );
    }

    return new Money(this.toMinorUnits(amount), currency);
  }

  static zero(currency: string): Money {
    this.assertCurrency(currency);
    return new Money(0n, currency);
  }

  /**
   * Reconstructs an already-persisted exact value without applying input rules.
   * It is intended only for trusted persistence adapters.
   */
  static rehydrate(amount: string, currency: string): Money {
    return new Money(this.toMinorUnits(amount), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const whole = absolute / 100n;
    const fractional = (absolute % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${whole.toString()}.${fractional}`;
  }

  toJSON(): string {
    return this.toString();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        DomainFailureCode.CURRENCY_MISMATCH,
        `Cannot operate on ${this.currency} and ${other.currency}.`,
      );
    }
  }

  private static toMinorUnits(amount: string): bigint {
    const negative = amount.startsWith("-");
    const unsigned = negative ? amount.slice(1) : amount;
    const [whole, fraction] = unsigned.split(".");
    const minorUnits = BigInt(`${whole}${fraction}`);
    return negative ? -minorUnits : minorUnits;
  }

  private static assertCurrency(currency: string): void {
    if (
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency) ||
      !ISO_CURRENCY_CODES.has(currency)
    ) {
      throw new DomainError(
        DomainFailureCode.INVALID_TRANSACTION,
        "Currency must be an uppercase ISO-4217 code.",
      );
    }
  }
}
