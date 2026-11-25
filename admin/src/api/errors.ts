/**
 * Тексты ошибок для оператора — по `code` из `api/docs/api-contract.md`.
 * `message` из ответа API сюда не попадает: это текст для логов, в нём английские подробности.
 * Неизвестный код показывается сам — так оператор может назвать его разработчику, а текст не выдумывается.
 */
import { ApiError, CLIENT_CODES } from './client'

const MESSAGES: Record<string, string> = {
  // общие
  [CLIENT_CODES.network]: 'Нет связи с сервером. Проверьте сеть и повторите.',
  [CLIENT_CODES.badResponse]: 'Сервер ответил непонятно. Обновите страницу и повторите.',
  HTTP_5XX: 'Сервер недоступен. Повторите позже.',
  INTERNAL: 'Внутренняя ошибка сервера. Повторите позже; если не проходит — сообщите разработчику.',
  UNAUTHENTICATED: 'Сессия истекла. Войдите снова.',
  VALIDATION_FAILED: 'Данные не прошли проверку: проверьте заполнение полей.',
  INVALID_JSON: 'Сервер не разобрал запрос. Обновите страницу и повторите.',
  JSON_REQUIRED: 'Сервер не разобрал запрос. Обновите страницу и повторите.',
  NOT_FOUND: 'Такого действия нет.',
  IDEMPOTENCY_KEY_REQUIRED: 'Запрос без ключа повтора. Обновите страницу и повторите.',
  IDEMPOTENCY_CONFLICT:
    'Эта попытка уже отправлялась с другими данными и, возможно, прошла. Закройте форму или уйдите со страницы и проверьте состояние перед повтором.',

  // вход
  INVALID_CREDENTIALS: 'Неверная почта или пароль.',
  LOGIN_THROTTLED: 'Слишком много неудачных попыток входа. Подождите и повторите.',
  LOGIN_BUSY: 'Сервер перегружен. Повторите вход через несколько секунд.',

  // назначения
  DESTINATION_NOT_FOUND: 'Назначение не найдено.',
  DESTINATION_NAME_TAKEN: 'Назначение с таким именем уже есть.',
  DESTINATION_TARGET_TAKEN: 'Это окружение Dokploy уже заведено другим назначением.',
  DESTINATION_VERSION_CONFLICT: 'Назначение успели изменить. Данные обновлены — откройте форму заново и проверьте.',
  DESTINATION_INVALID_URL: 'Адрес Dokploy — не URL.',
  DESTINATION_INVALID_NAME: 'Имя назначения пустое или длиннее 80 символов.',
  DESTINATION_INSECURE_URL: 'Адрес по http не разрешён настройками сервера — нужен https.',
  DESTINATION_KEY_REQUIRED: 'При смене адреса нужен новый API-ключ.',
  DESTINATION_KEY_REJECTED: 'Dokploy не принял API-ключ.',
  DESTINATION_ENVIRONMENT_NOT_FOUND: 'В Dokploy нет такого окружения.',
  DESTINATION_SERVER_NOT_FOUND: 'В Dokploy нет такого сервера.',
  DESTINATION_UNREACHABLE: 'Dokploy недоступен или ответил непонятно.',
  DESTINATION_RATE_LIMITED: 'Ключ Dokploy исчерпал свой лимит запросов — выпустите ключ без лимита.',
  DESTINATION_HAS_DEPLOYMENTS: 'На назначении есть роботы: адрес, окружение и сервер менять нельзя, пока они не удалены.',
  DESTINATION_KEY_CANNOT_SEE_DEPLOYMENTS:
    'Новый ключ не видит приложения роботов этого назначения — нужен ключ того же пользователя Dokploy.',

  // каталог
  CATALOG_TEMPLATE_NOT_FOUND: 'Шаблон не найден.',

  // клиенты
  CUSTOMER_NOT_FOUND: 'Клиент не найден.',
  CUSTOMER_NAME_TAKEN: 'Клиент с таким именем уже есть (в том числе среди архивных).',
  CUSTOMER_VERSION_CONFLICT: 'Клиента успели изменить. Данные обновлены — откройте форму заново и проверьте.',
  CUSTOMER_ALREADY_IN_MODE: 'Клиент уже в этом режиме.',
  CUSTOMER_ARCHIVED: 'Клиент в архиве — изменить его нельзя.',
  CUSTOMER_INVALID_NAME: 'Имя клиента пустое или слишком длинное.',
  CUSTOMER_INVALID_ACCOUNT: 'Неверный номер счёта.',
  CUSTOMER_LIVE_CONFIRMATION_REQUIRED: 'Нужно подтверждение: введите точное имя клиента.',
  CUSTOMER_TOKEN_REJECTED: 'T-Invest не принял токен.',
  CUSTOMER_ACCOUNT_NOT_FOUND: 'У этого токена нет такого открытого счёта.',
  CUSTOMER_TOKEN_READ_ONLY: 'Боевой токен только на чтение — нужен токен с правом торговли.',
  CUSTOMER_ACCOUNT_NOT_TRADABLE: 'Счёт не брокерский и не ИИС — торговать на нём нельзя.',
  CUSTOMER_LIVE_TOKEN_IN_SANDBOX: 'Для песочницы дан токен с полным доступом к реальному счёту. Нужен токен песочницы.',
  CUSTOMER_BROKER_UNAVAILABLE: 'T-Invest сейчас недоступен. Повторите позже.',
  CUSTOMER_LIVE_CHECK_DISABLED: 'Проверка боевых токенов выключена на сервере: боевой режим и смена боевого токена или счёта недоступны.',
  CUSTOMER_HAS_DEPLOYMENTS: 'У клиента есть неудалённые роботы: сначала удалите их.',

  // развёртывания
  DEPLOYMENT_NOT_FOUND: 'Развёртывание не найдено.',
  TOO_MANY_STREAMS: 'Открыто слишком много живых потоков (другие вкладки). Закройте лишние и повторите.',
  DEPLOYMENT_OPERATION_IN_PROGRESS: 'Идёт другая операция — дождитесь её окончания.',
  DEPLOYMENT_INVALID_STATE: 'В текущем статусе это действие недоступно. Данные обновлены.',
  DEPLOYMENT_VERSION_CONFLICT: 'Развёртывание успели изменить. Данные обновлены — откройте форму заново и проверьте.',
  DEPLOYMENT_INVALID_CONFIG: 'Конфиг не прошёл проверку по схеме шаблона.',
  DEPLOYMENT_CUSTOMER_UNAVAILABLE: 'Клиент в архиве или недоступен.',
  DEPLOYMENT_DESTINATION_UNAVAILABLE: 'Назначение выключено или недоступно.',
  DEPLOYMENT_TEMPLATE_UNAVAILABLE: 'Шаблон выведен из каталога или недоступен.',
  DEPLOYMENT_TEMPLATE_NOT_LIVE_SAFE: 'Робот не проверяет сертификат T-Invest — боевому клиенту его ставить нельзя.',
}

/** Текст ошибки для оператора. Никогда не возвращает `message` из ответа API */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Непредвиденная ошибка в админке. Обновите страницу.'
  const text = MESSAGES[error.code] ?? `Ошибка ${error.status || 'сети'}.`
  const retry = error.retryAfter ? ` Повторить можно через ${error.retryAfter} с.` : ''
  return `${text}${retry} (${error.code})`
}

/** Текст по коду, пришедшему не в ответе API, а в событии потока (`logs-error`) */
export function codeMessage(code: string): string {
  return `${MESSAGES[code] ?? 'Ошибка потока.'} (${code})`
}

/**
 * Коды, после которых показанные данные устарели: конфликт версии или состояния, а также 409 на повтор
 * после обрыва (первый запрос мог пройти). Экран перечитывает данные, а не повторяет запрос вслепую
 */
export function needsRefetch(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404)
}
