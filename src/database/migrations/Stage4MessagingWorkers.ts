import { Migration } from "@mikro-orm/migrations";

export class Stage4MessagingWorkers extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "lease_owner" text null,
        add column "lease_expires_at" timestamptz(3) null,
        add constraint "wager_transactions_reference_lease_check" check (
          (
            "lease_owner" is null
            and "lease_expires_at" is null
          )
          or (
            "status" = 'PENDING_REFERENCE'
            and "lease_owner" is not null
            and btrim("lease_owner") <> ''
            and "lease_expires_at" is not null
          )
        );
      create index "wager_transactions_reference_lease_due"
        on "wager_transactions" ("next_retry_at", "lease_expires_at", "id")
        where "status" = 'PENDING_REFERENCE';

      create table "inbox_message_conflicts" (
        "consumer_name" text not null,
        "message_id" text not null,
        "payload_hash" text not null,
        "payload" jsonb not null,
        "received_at" timestamptz(3) not null,
        constraint "inbox_message_conflicts_pkey"
          primary key ("consumer_name", "message_id", "payload_hash"),
        constraint "inbox_message_conflicts_payload_check"
          check (jsonb_typeof("payload") = 'object')
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from "inbox_message_conflicts") then
          raise exception 'Refusing to drop durable Inbox message-conflict records'
            using errcode = '55000';
        end if;
      end;
      $$;
      drop table "inbox_message_conflicts";
      drop index "wager_transactions_reference_lease_due";
      alter table "wager_transactions"
        drop constraint "wager_transactions_reference_lease_check",
        drop column "lease_owner",
        drop column "lease_expires_at";
    `);
  }
}
