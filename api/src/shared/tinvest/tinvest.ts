import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Адреса gRPC T-Invest API по режиму. Источник — официальная документация T-Invest, страница «Отличия
 * песочницы от продового контура» (github.com/RussianInvestments/investAPI, src/docs/url_difference.md,
 * сверено 2026-11-24). Хосты `*.tbank.ru` на том же адресе тоже отвечают, но в документации названы эти.
 *
 * Адрес выбирает платформа по `tradingMode` развёртывания, а не оператор: боевой токен не должен уходить
 * на адрес, введённый руками.
 */
export const TINVEST_ADDRESS = {
  live: 'invest-public-api.tinkoff.ru:443',
  sandbox: 'sandbox-invest-public-api.tinkoff.ru:443',
} as const satisfies Record<'live' | 'sandbox', string>

/**
 * Корневой сертификат, которым подписаны хосты T-Invest: Russian Trusted Root CA Минцифры. Его нет
 * в стандартных хранилищах (в том числе в alpine-образах роботов), поэтому платформа кладёт его роботу
 * файлом и указывает Go через `SSL_CERT_FILE` — так робот проверяет сертификат T-Invest и доверяет только
 * этому корню. Источник — gu-st.ru; цепочка живого invest-public-api проверена этим корнем 2026-11-24.
 */
export const TINVEST_ROOT_CA_PEM = readFileSync(path.resolve(import.meta.dir, '../../../assets/russian-trusted-root-ca.pem'), 'utf8')
export const TINVEST_ROOT_CA_SHA256 = 'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31'

/** Куда в контейнере робота кладётся корень и какая переменная на него указывает */
export const ROBOT_CA_MOUNT_PATH = '/etc/ssl/botyard/tinvest-root-ca.pem'
export const ROBOT_CA_ENV = { SSL_CERT_FILE: ROBOT_CA_MOUNT_PATH } as const
