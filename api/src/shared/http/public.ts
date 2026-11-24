import { SetMetadata } from '@nestjs/common'

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE')

/** Ручка без входа (health, вход, выход). Общий маркер: модули не зависят от presentation модуля auth */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)
