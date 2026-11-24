import { Injectable } from '@nestjs/common'
import { SecretBox, secretContext, secretHint } from '../../../shared/crypto/secret-box'

/**
 * Ключ Dokploy назначения. Контекст конверта привязан к id и к адресу: ключ откроется только для
 * того адреса, для которого его ввёл оператор (docs/architecture.md, «Безопасность»).
 */
@Injectable()
export class DestinationSecrets {
  constructor(private readonly box: SecretBox) {}

  async seal(destinationId: string, baseUrl: string, apiKey: string): Promise<{ sealed: Uint8Array; hint: string }> {
    return { sealed: await this.box.seal(apiKey, context(destinationId, baseUrl)), hint: secretHint(apiKey) }
  }

  open(destinationId: string, baseUrl: string, sealed: Uint8Array): Promise<string> {
    return this.box.open(sealed, context(destinationId, baseUrl))
  }
}

function context(destinationId: string, baseUrl: string) {
  return secretContext('destination', destinationId, 'api_key', baseUrl)
}
