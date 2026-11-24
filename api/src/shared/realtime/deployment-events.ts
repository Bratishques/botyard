import { EventEmitter } from 'node:events'
import { Global, Logger, Module, type OnModuleDestroy } from '@nestjs/common'
import { RedisClient } from 'bun'
import { APP_CONFIG, type AppConfig } from '../config/config'

const CHANNEL = 'botyard:deployments'

export type DeploymentChangedListener = (deploymentId: string) => void

/**
 * Шина «развёртывание изменилось» для живого статуса в админке (SSE). Событие — только id: подсказка
 * перечитать развёртывание через API, а не его новое состояние. Поэтому потерянное или задвоенное событие стоит
 * одного лишнего запроса и не может показать неверный статус.
 *
 * Публикуют после коммита все процессы (http, воркер, reconciler), слушают реплики http — между процессами через
 * Redis pub/sub. Публикация — «лучшее усилие»: ошибка шины не отменяет уже записанное изменение.
 */
export interface DeploymentEvents {
  changed(deploymentId: string): void
  /** Подписка; возвращает отписку */
  subscribe(listener: DeploymentChangedListener): () => void
}

export const DEPLOYMENT_EVENTS = Symbol('DEPLOYMENT_EVENTS')

/** Один процесс без Redis (тесты, разработка в одном процессе) */
export class LocalDeploymentEvents implements DeploymentEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  changed(deploymentId: string): void {
    this.emitter.emit(CHANNEL, deploymentId)
  }

  subscribe(listener: DeploymentChangedListener): () => void {
    this.emitter.on(CHANNEL, listener)
    return () => this.emitter.off(CHANNEL, listener)
  }
}

/**
 * Через Redis. Подписчик — отдельное соединение (в режиме подписки Redis не принимает прочие команды) и
 * создаётся только у тех, кто слушает. Соединение подписчика закрылось — пересоздаётся с подпиской заново: Bun сам
 * переподключается, но после исчерпания попыток зовёт `onclose`, и сохранность подписки после переподключения
 * этим не гарантирована.
 */
export class RedisDeploymentEvents implements DeploymentEvents, OnModuleDestroy {
  private readonly logger = new Logger(RedisDeploymentEvents.name)
  private readonly local = new LocalDeploymentEvents()
  private readonly publisher: RedisClient
  private subscriber: RedisClient | null = null
  private listeners = 0
  private closed = false

  constructor(private readonly url: string) {
    this.publisher = new RedisClient(url)
  }

  changed(deploymentId: string): void {
    this.publisher.publish(CHANNEL, deploymentId).catch((error: unknown) => {
      this.logger.warn({ deploymentId, reason: error instanceof Error ? error.message : 'failed' }, 'deployment event was not published')
    })
  }

  subscribe(listener: DeploymentChangedListener): () => void {
    const unsubscribe = this.local.subscribe(listener)
    this.listeners++
    if (!this.subscriber) this.connectSubscriber()

    return () => {
      unsubscribe()
      this.listeners--
    }
  }

  onModuleDestroy(): void {
    this.closed = true
    this.subscriber?.close()
    this.publisher.close()
  }

  private connectSubscriber(): void {
    const subscriber = new RedisClient(this.url)
    this.subscriber = subscriber
    subscriber.onclose = () => {
      if (this.closed || this.subscriber !== subscriber) return
      this.subscriber = null
      this.logger.warn('deployment events subscriber closed, reconnecting')
      setTimeout(() => {
        if (!this.closed && this.listeners > 0 && !this.subscriber) this.connectSubscriber()
      }, 1_000)
    }
    subscriber
      .subscribe(CHANNEL, (message) => this.local.changed(message))
      .catch((error: unknown) => {
        this.logger.warn({ reason: error instanceof Error ? error.message : 'failed' }, 'deployment events subscription failed')
      })
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DEPLOYMENT_EVENTS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => (config.REDIS_URL ? new RedisDeploymentEvents(config.REDIS_URL) : new LocalDeploymentEvents()),
    },
  ],
  exports: [DEPLOYMENT_EVENTS],
})
export class RealtimeModule {}
