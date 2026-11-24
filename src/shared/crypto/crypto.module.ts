import { Global, Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../config/config'
import { LocalKeyEncryptionKey } from './key-encryption-key'
import { SecretBox } from './secret-box'

/**
 * Один `SecretBox` на процесс. Сейчас в нём один мастер-ключ; при ротации сюда добавляется
 * прежний ключ для чтения старых конвертов, а новые пишутся текущим.
 */
@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SecretBox([new LocalKeyEncryptionKey(config.SECRETS_MASTER_KEY_ID, config.SECRETS_MASTER_KEY)]),
    },
  ],
  exports: [SecretBox],
})
export class CryptoModule {}
