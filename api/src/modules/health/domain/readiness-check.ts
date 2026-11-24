/** Зависимость, без которой процесс не готов принимать трафик */
export interface ReadinessCheck {
  readonly name: string
  probe(): Promise<void>
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS')
