import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../src/config/environment";
import { createDatabaseOptions } from "../../src/database/mikro-orm.config";

export async function createTestDatabase() {
  const source =
    process.env.TEST_DATABASE_URL ?? loadEnvironment().DATABASE_URL;
  const admin = await MikroORM.init(createDatabaseOptions(source));
  const name = `stage2_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(source);
  url.pathname = `/${name}`;
  let orm: MikroORM | undefined;
  let created = false;
  try {
    await admin.em.getConnection().execute(`create database "${name}"`);
    created = true;
    orm = await MikroORM.init(createDatabaseOptions(url.toString()));
    return {
      orm,
      url: url.toString(),
      async close() {
        try {
          await orm?.close(true);
          await admin.em.getConnection().execute(`drop database "${name}"`);
        } finally {
          await admin.close(true);
        }
      },
    };
  } catch (error) {
    try {
      await orm?.close(true);
      if (created) {
        await admin.em.getConnection().execute(`drop database "${name}"`);
      }
    } finally {
      await admin.close(true);
    }
    throw error;
  }
}
