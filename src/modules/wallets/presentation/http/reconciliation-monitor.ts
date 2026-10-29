import { Injectable, Logger } from "@nestjs/common";
import { Reconciliation } from "../../../ledger/application/ports/ledger-repository";

@Injectable()
export class ReconciliationMonitor {
  private readonly logger = new Logger(ReconciliationMonitor.name);
  private discrepancies = 0;

  get discrepancyCount(): number {
    return this.discrepancies;
  }

  record(result: Reconciliation): void {
    if (!result.consistent) {
      this.discrepancies += 1;
      this.logger.error(
        JSON.stringify({
          event: "wallet_reconciliation_discrepancy",
          ...result,
        }),
      );
    }
  }
}
