import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../config/environment";
import { createDatabaseOptions } from "./mikro-orm.config";

type MigrationCommand = "up" | "down";

function parseCommand(args: string[]): MigrationCommand {
  if (
    args.length > 1 ||
    (args[0] !== undefined && args[0] !== "up" && args[0] !== "down")
  ) {
    throw new Error("Usage: bun run src/database/migrate.ts [up|down]");
  }
  return args[0] === "down" ? "down" : "up";
}

async function runMigrationCommand(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const environment = loadEnvironment();
  const orm = await MikroORM.init(
    createDatabaseOptions(environment.DATABASE_URL),
  );

  try {
    const migrator = orm.getMigrator();
    if (command === "up") {
      await migrator.up();
    } else {
      await migrator.down();
    }
  } finally {
    await orm.close(true);
  }
}

void runMigrationCommand().catch((error: unknown) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
