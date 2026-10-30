import { Injectable, Logger } from "@nestjs/common";
import { Reconciliation } from "../../../ledger/application/ports/ledger-repository";
import { MetricsService } from "../../../metrics/metrics.service";
import { currentCorrelationId } from "../../../../observability/correlation-context";

@Injectable()
export class ReconciliationMonitor {
  private readonly logger = new Logger(ReconciliationMonitor.name);
  private discrepancies = 0;

  constructor(private readonly metrics: MetricsService) {}

  get discrepancyCount(): number {
    return this.discrepancies;
  }

  record(result: Reconciliation): void {
    if (!result.consistent) {
      this.discrepancies += 1;
      this.metrics.recordReconciliationDiscrepancy();
      this.logger.error(
        JSON.stringify({
          event: "wallet_reconciliation_discrepancy",
          correlationId: currentCorrelationId(),
          ...result,
        }),
      );
    }
  }
}
