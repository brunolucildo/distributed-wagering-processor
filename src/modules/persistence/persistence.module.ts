import {
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../config/environment";
import { createDatabaseOptions } from "../../database/mikro-orm.config";

@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: () =>
        MikroORM.init(createDatabaseOptions(loadEnvironment().DATABASE_URL)),
    },
    DatabaseShutdown,
  ],
  exports: [MikroORM],
})
export class PersistenceModule {}
