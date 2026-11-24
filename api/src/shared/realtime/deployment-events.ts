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
 * Redis pub/sub. Публикация — «лучшее усилие»: ошибка шины не отменяет уже записанное изменение. Если подписка
 * прерывалась, события за разрыв потеряны — слушатель получает `onResync` и перечитывает всё.
 */
export interface DeploymentEvents {
  changed(deploymentId: string): void
  /** Подписка; возвращает отписку */
  subscribe(listener: DeploymentChangedListener, onResync?: () => void): () => void
}

export const DEPLOYMENT_EVENTS = Symbol('DEPLOYMENT_EVENTS')

const RESYNC = 'botyard:resync'

/** Один процесс без Redis (тесты, разработка в одном процессе) */
export class LocalDeploymentEvents implements DeploymentEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  changed(deploymentId: string): void {
    this.emitter.emit(CHANNEL, deploymentId)
  }

  /** Подписка восстановлена после разрыва */
  resync(): void {
    this.emitter.emit(RESYNC)
  }

  subscribe(listener: DeploymentChangedListener, onResync?: () => void): () => void {
    this.emitter.on(CHANNEL, listener)
    if (onResync) this.emitter.on(RESYNC, onResync)
    return () => {
      this.emitter.off(CHANNEL, listener)
      if (onResync) this.emitter.off(RESYNC, onResync)
    }
  }
}

const RECONNECT_MS = 1_000

/**
 * Через Redis. Подписчик — отдельное соединение (в режиме подписки Redis не принимает прочие команды) и
 * создаётся только у тех, кто слушает. Автопереподключение Bun выключено у обоих соединений: восстановит ли
 * оно подписку, не гарантировано, а после исчерпания попыток клиент остаётся мёртвым. Вместо этого любой обрыв —
 * новое соединение: подписчик пересоздаётся с подпиской заново (и слушатели получают `resync`), издатель —
 * при следующей публикации.
 */
export class RedisDeploymentEvents implements DeploymentEvents, OnModuleDestroy {
  private readonly logger = new Logger(RedisDeploymentEvents.name)
  private readonly local = new LocalDeploymentEvents()
  private publisher: RedisClient | null = null
  private subscriber: RedisClient | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  /** Подписка уже была: следующая успешная — восстановление после разрыва */
  private subscribedBefore = false
  private listeners = 0
  private closed = false

  constructor(private readonly url: string) {}

  changed(deploymentId: string): void {
    if (this.closed) return
    const publisher = this.publisherClient()
    publisher.publish(CHANNEL, deploymentId).catch((error: unknown) => {
      this.dropPublisher(publisher)
      this.logger.warn({ deploymentId, reason: reasonOf(error) }, 'deployment event was not published')
    })
  }

  subscribe(listener: DeploymentChangedListener, onResync?: () => void): () => void {
    const unsubscribe = this.local.subscribe(listener, onResync)
    this.listeners++
    if (!this.subscriber && !this.reconnect) this.connectSubscriber()

    let active = true
    return () => {
      if (!active) return
      active = false
      unsubscribe()
      this.listeners--
    }
  }

  onModuleDestroy(): void {
    this.closed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.subscriber?.close()
    this.publisher?.close()
  }

  private publisherClient(): RedisClient {
    if (!this.publisher) {
      const publisher = new RedisClient(this.url, { autoReconnect: false })
      publisher.onclose = () => this.dropPublisher(publisher)
      this.publisher = publisher
    }

    return this.publisher
  }

  private dropPublisher(publisher: RedisClient): void {
    if (this.publisher !== publisher) return
    this.publisher = null
    publisher.close()
  }

  private connectSubscriber(): void {
    const subscriber = new RedisClient(this.url, { autoReconnect: false })
    this.subscriber = subscriber
    subscriber.onclose = () => this.subscriberLost(subscriber)
    subscriber
      .subscribe(CHANNEL, (message) => this.local.changed(message))
      .then(() => {
        if (this.subscriber !== subscriber) return
        if (this.subscribedBefore) this.local.resync()
        this.subscribedBefore = true
      })
      .catch((error: unknown) => {
        this.logger.warn({ reason: reasonOf(error) }, 'deployment events subscription failed')
        this.subscriberLost(subscriber)
      })
  }

  /** Соединение подписчика потеряно (или не подписалось) — новое через паузу, пока есть слушатели */
  private subscriberLost(subscriber: RedisClient): void {
    if (this.closed || this.subscriber !== subscriber) return
    this.subscriber = null
    // Подписка, которая не случилась, — тоже разрыв: события между ней и следующей потеряны
    this.subscribedBefore = true
    subscriber.close()
    this.logger.warn('deployment events subscriber lost, reconnecting')
    this.reconnect = setTimeout(() => {
      this.reconnect = null
      if (!this.closed && this.listeners > 0 && !this.subscriber) this.connectSubscriber()
    }, RECONNECT_MS)
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'failed'
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
