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
import { RejectNonFiniteMoney } from "./migrations/RejectNonFiniteMoney";
import { Stage3WagerIdentity } from "./migrations/Stage3WagerIdentity";
import { Stage4MessagingWorkers } from "./migrations/Stage4MessagingWorkers";

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
        {
          name: "RejectNonFiniteMoney",
          class: RejectNonFiniteMoney,
        },
        {
          name: "Stage3WagerIdentity",
          class: Stage3WagerIdentity,
        },
        {
          name: "Stage4MessagingWorkers",
          class: Stage4MessagingWorkers,
        },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  };
}
