import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

/**
 * Валидатор схем конфига робота: строгий режим и стандартные форматы (`uri`, `email`, `date-time`…).
 * Один и тот же набор проверяет схему при синхронизации каталога и конфиг при развёртывании, поэтому формат
 * не окажется «неизвестным» в одном месте и рабочим в другом. Новый экземпляр на каждую схему: одинаковый
 * `$id` в схемах двух шаблонов не конфликтует.
 *
 * `useDefaults` — для конфига развёртывания: значения `default` из схемы подставляются, и шаблон не
 * отрендерит пустое значение там, где автор робота задал умолчание.
 */
export function configSchemaValidator(options: { useDefaults?: boolean } = {}): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: options.useDefaults ?? false })
  addFormats(ajv)
  return ajv
}
