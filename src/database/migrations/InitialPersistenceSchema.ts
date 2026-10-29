import { Migration } from "@mikro-orm/migrations";

export class InitialPersistenceSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" text not null,
        "currency" text not null,
        "balance" numeric(38,2) not null,
        "version" integer not null,
        "created_at" timestamptz(3) not null,
        "updated_at" timestamptz(3) not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_id_currency_unique" unique ("id", "currency"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_player_id_nonblank_check" check (btrim("player_id") <> ''),
        constraint "wallets_currency_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_nonnegative_check" check ("balance" >= 0),
        constraint "wallets_version_check" check ("version" >= 1)
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" text null,
        "external_transaction_id" text null,
        "player_id" text not null,
        "wallet_id" uuid not null,
        "currency" text not null,
        "round_id" text null,
        "kind" text not null,
        "status" text not null,
        "amount" numeric(38,2) not null,
        "reference_external_transaction_id" text null,
        "failure_code" text null,
        "created_at" timestamptz(3) not null,
        "completed_at" timestamptz(3) null,
        "idempotency_key" text null,
        "payload_hash" text null,
        "game_id" text null,
        "reference_transaction_id" uuid null,
        "response_snapshot" jsonb null,
        "next_retry_at" timestamptz(3) null,
        "pending_reference_expires_at" timestamptz(3) null,
        "retry_count" integer not null default 0,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_id_wallet_currency_unique"
          unique ("id", "wallet_id", "currency"),
        constraint "wager_transactions_wallet_currency_fkey"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on update restrict on delete restrict,
        constraint "wager_transactions_reference_fkey"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id") on update restrict on delete restrict,
        constraint "wager_transactions_identity_shape_check" check (
          (
            "kind" = 'OPENING'
            and "provider_id" is null
            and "external_transaction_id" is null
            and "round_id" is null
            and "idempotency_key" is null
            and "payload_hash" is null
            and "reference_external_transaction_id" is null
            and "reference_transaction_id" is null
            and "status" = 'PROCESSED'
            and "failure_code" is null
            and "completed_at" is not null
            and "amount" > 0
          )
          or
          (
            "kind" <> 'OPENING'
            and "provider_id" is not null and btrim("provider_id") <> ''
            and "external_transaction_id" is not null and btrim("external_transaction_id") <> ''
            and "round_id" is not null and btrim("round_id") <> ''
            and "idempotency_key" is not null and btrim("idempotency_key") <> ''
            and "payload_hash" is not null and btrim("payload_hash") <> ''
            and "amount" > 0
          )
        ),
        constraint "wager_transactions_kind_check"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_terminal_state_check" check (
          (
            "status" in ('PENDING', 'PENDING_REFERENCE')
            and "completed_at" is null
            and "failure_code" is null
          )
          or (
            "status" = 'PROCESSED'
            and "completed_at" is not null
            and "failure_code" is null
          )
          or (
            "status" in ('REJECTED', 'FAILED')
            and "completed_at" is not null
            and "failure_code" is not null
          )
        ),
        constraint "wager_transactions_failure_code_check" check (
          "failure_code" is null or "failure_code" in (
            'INVALID_TRANSACTION',
            'PERMANENT_PROCESSING_FAILURE',
            'WALLET_NOT_FOUND',
            'WALLET_MISMATCH',
            'CURRENCY_MISMATCH',
            'INSUFFICIENT_FUNDS',
            'REFERENCE_NOT_FOUND',
            'REFERENCE_INVALID',
            'REFERENCE_ALREADY_REVERSED',
            'REVERSAL_AMOUNT_MISMATCH',
            'REVERSAL_WOULD_OVERDRAW',
            'INVALID_STATE_TRANSITION'
          )
        ),
        constraint "wager_transactions_failed_code_check" check (
          "status" <> 'FAILED' or "failure_code" = 'PERMANENT_PROCESSING_FAILURE'
        ),
        constraint "wager_transactions_processed_reversal_reference_check" check (
          "kind" not in ('REFUND', 'ROLLBACK') or "status" <> 'PROCESSED'
          or "reference_transaction_id" is not null
        ),
        constraint "wager_transactions_reference_kind_check" check (
          ("kind" not in ('REFUND', 'ROLLBACK') or (
            "reference_external_transaction_id" is not null
            and btrim("reference_external_transaction_id") <> ''
          ))
          and (
            "reference_external_transaction_id" is null
            or ("kind" in ('WIN', 'REFUND', 'ROLLBACK')
              and btrim("reference_external_transaction_id") <> '')
          )
        ),
        constraint "wager_transactions_retry_count_check" check ("retry_count" >= 0),
        constraint "wager_transactions_currency_check" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);
    this.addSql(`
      create unique index "wager_transactions_provider_external_unique"
        on "wager_transactions" ("provider_id", "external_transaction_id");
      create unique index "wager_transactions_provider_idempotency_unique"
        on "wager_transactions" ("provider_id", "idempotency_key");
      create unique index "wager_transactions_one_opening_per_wallet"
        on "wager_transactions" ("wallet_id") where "kind" = 'OPENING';
      create unique index "wager_transactions_one_processed_reversal"
        on "wager_transactions" ("reference_transaction_id")
        where "status" = 'PROCESSED'
          and "kind" in ('REFUND', 'ROLLBACK')
          and "reference_transaction_id" is not null;
      create index "wager_transactions_reference_lookup"
        on "wager_transactions" ("provider_id", "external_transaction_id");
      create index "wager_transactions_pending_reference_due"
        on "wager_transactions" ("next_retry_at", "pending_reference_expires_at", "id")
        where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "amount" numeric(38,2) not null,
        "currency" text not null,
        "direction" text not null,
        "balance_before" numeric(38,2) not null,
        "balance_after" numeric(38,2) not null,
        "created_at" timestamptz(3) not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_transaction_unique" unique ("transaction_id"),
        constraint "wallet_ledger_entries_wallet_currency_fkey"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on update restrict on delete restrict,
        constraint "wallet_ledger_entries_transaction_wallet_currency_fkey"
          foreign key ("transaction_id", "wallet_id", "currency")
          references "wager_transactions" ("id", "wallet_id", "currency")
          on update restrict on delete restrict,
        constraint "wallet_ledger_entries_amount_check" check ("amount" > 0),
        constraint "wallet_ledger_entries_balances_check"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_entries_direction_check"
          check ("direction" in ('CREDIT', 'DEBIT')),
        constraint "wallet_ledger_entries_balance_equation_check" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
          or ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        ),
        constraint "wallet_ledger_entries_currency_check" check ("currency" ~ '^[A-Z]{3}$')
      );
      create index "wallet_ledger_entries_wallet_pagination"
        on "wallet_ledger_entries" ("wallet_id", "created_at", "id");
    `);

    this.addSql(`
      create function "reject_wallet_ledger_mutation"()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$;
      create trigger "wallet_ledger_entries_no_update_or_delete"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "reject_wallet_ledger_mutation"();
      create trigger "wallet_ledger_entries_no_truncate"
        before truncate on "wallet_ledger_entries"
        for each statement execute function "reject_wallet_ledger_mutation"();
    `);

    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" text not null,
        "message_id" text not null,
        "payload_hash" text not null,
        "status" text not null,
        "attempts" integer not null default 0,
        "payload" jsonb null,
        "received_at" timestamptz(3) not null,
        "completed_at" timestamptz(3) null,
        "failure_code" text null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_identity_check" check (
          btrim("consumer_name") <> '' and btrim("message_id") <> ''
        ),
        constraint "inbox_messages_payload_hash_check" check (btrim("payload_hash") <> ''),
        constraint "inbox_messages_status_check" check (
          (
            "status" = 'PROCESSING'
            and "completed_at" is null
            and "failure_code" is null
          )
          or (
            "status" = 'COMPLETED'
            and "completed_at" is not null
            and "failure_code" is null
          )
          or (
            "status" = 'FAILED'
            and "completed_at" is not null
            and "failure_code" is not null
          )
        ),
        constraint "inbox_messages_attempts_check" check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "event_id" uuid not null,
        "event_type" text not null,
        "aggregate_id" text not null,
        "payload" jsonb not null,
        "status" text not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz(3) not null,
        "lease_owner" text null,
        "lease_expires_at" timestamptz(3) null,
        "created_at" timestamptz(3) not null,
        "published_at" timestamptz(3) null,
        "last_error" text null,
        constraint "outbox_messages_pkey" primary key ("event_id"),
        constraint "outbox_messages_type_aggregate_check" check (
          btrim("event_type") <> '' and btrim("aggregate_id") <> ''
        ),
        constraint "outbox_messages_payload_check" check (jsonb_typeof("payload") = 'object'),
        constraint "outbox_messages_status_check" check (
          (
            "status" in ('PENDING', 'FAILED')
            and "lease_owner" is null
            and "lease_expires_at" is null
            and "published_at" is null
          )
          or (
            "status" = 'PROCESSING'
            and "lease_owner" is not null and btrim("lease_owner") <> ''
            and "lease_expires_at" is not null
            and "published_at" is null
          )
          or (
            "status" = 'PUBLISHED'
            and "lease_owner" is null
            and "lease_expires_at" is null
            and "published_at" is not null
          )
        ),
        constraint "outbox_messages_attempts_check" check ("attempts" between 0 and 10)
      );
      create index "outbox_messages_due"
        on "outbox_messages" ("next_attempt_at", "lease_expires_at", "created_at", "event_id")
        where "status" in ('PENDING', 'PROCESSING');
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      lock table "wallets", "wager_transactions", "wallet_ledger_entries",
        "inbox_messages", "outbox_messages" in access exclusive mode;
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from "wallets"
          union all select 1 from "wager_transactions"
          union all select 1 from "wallet_ledger_entries"
          union all select 1 from "inbox_messages"
          union all select 1 from "outbox_messages"
        ) then
          raise exception 'Refusing to drop the initial schema because financial or messaging data exists'
            using errcode = '55000';
        end if;
      end;
      $$;
    `);
    this.addSql(`
      drop trigger if exists "wallet_ledger_entries_no_update_or_delete" on "wallet_ledger_entries";
      drop trigger if exists "wallet_ledger_entries_no_truncate" on "wallet_ledger_entries";
      drop table if exists "outbox_messages";
      drop table if exists "inbox_messages";
      drop table if exists "wallet_ledger_entries";
      drop table if exists "wager_transactions";
      drop table if exists "wallets";
      drop function if exists "reject_wallet_ledger_mutation"();
    `);
  }
}
