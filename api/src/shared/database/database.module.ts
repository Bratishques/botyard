import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../config/config'
import { createDb, DB, type Db } from './database'

@Global()
@Module({
  providers: [{ provide: DB, inject: [APP_CONFIG], useFactory: (config: AppConfig): Db => createDb(config.DATABASE_URL) }],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy()
  }
}
