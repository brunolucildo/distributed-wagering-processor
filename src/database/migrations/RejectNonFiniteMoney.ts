import { Migration } from "@mikro-orm/migrations";

export class RejectNonFiniteMoney extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wallets" add constraint "wallets_balance_finite_check"
        check ("balance" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      alter table "wager_transactions" add constraint "wager_transactions_amount_finite_check"
        check ("amount" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_money_finite_check"
        check (
          "amount" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
          and "balance_before" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
          and "balance_after" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_money_finite_check";
      alter table "wager_transactions" drop constraint "wager_transactions_amount_finite_check";
      alter table "wallets" drop constraint "wallets_balance_finite_check";
    `);
  }
}
