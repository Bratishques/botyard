import { Global, Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../config/config'
import { LocalKeyEncryptionKey } from './key-encryption-key'
import { SecretBox } from './secret-box'

/**
 * Один `SecretBox` на процесс с одним мастер-ключом. Ротация (прежний ключ для чтения и
 * перешифровка) не реализована — см. «Безопасность» в docs/architecture.md.
 */
@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SecretBox([new LocalKeyEncryptionKey(config.SECRETS_MASTER_KEY_ID, config.SECRETS_MASTER_KEY.reveal())]),
    },
  ],
  exports: [SecretBox],
})
export class CryptoModule {}
