import { Migration } from "@mikro-orm/migrations";

export class Stage3WagerIdentity extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_wallet_currency_fkey";
      alter table "wager_transactions"
        add constraint "wager_transactions_wallet_id_fkey"
        foreign key ("wallet_id") references "wallets" ("id")
        on update restrict on delete restrict;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      do $$
      begin
        if exists (
          select 1
          from "wager_transactions" t
          join "wallets" w on w."id" = t."wallet_id"
          where t."currency" <> w."currency"
        ) then
          raise exception 'Refusing to restore wallet-currency constraint while rejected currency-mismatch transactions exist'
            using errcode = '55000';
        end if;
      end;
      $$;
      alter table "wager_transactions"
        drop constraint "wager_transactions_wallet_id_fkey";
      alter table "wager_transactions"
        add constraint "wager_transactions_wallet_currency_fkey"
        foreign key ("wallet_id", "currency")
        references "wallets" ("id", "currency")
        on update restrict on delete restrict;
    `);
  }
}
