import { Migrator } from "@mikro-orm/migrations";
import type { Options } from "@mikro-orm/postgresql";
import {
  InboxMessageRecordSchema,
  LedgerEntryRecordSchema,
  OutboxMessageRecordSchema,
  WagerTransactionRecordSchema,
  WalletRecordSchema,
} from "./entities";
import { InitialPersistenceSchema } from "./migrations/InitialPersistenceSchema";

export function createDatabaseOptions(databaseUrl: string): Options {
  return {
    clientUrl: databaseUrl,
    entities: [
      WalletRecordSchema,
      WagerTransactionRecordSchema,
      LedgerEntryRecordSchema,
      InboxMessageRecordSchema,
      OutboxMessageRecordSchema,
    ],
    extensions: [Migrator],
    migrations: {
      path: "./dist/database/migrations",
      pathTs: "./src/database/migrations",
      migrationsList: [
        {
          name: "InitialPersistenceSchema",
          class: InitialPersistenceSchema,
        },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  };
}
