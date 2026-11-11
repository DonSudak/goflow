# Сервис экспорта историй

Расширяемый сервис для экспорта историй Go Flow в различные игровые движки и форматы.

## Особенности

- **Расширяемая архитектура**: Легко добавлять поддержку новых форматов экспорта
- **Принципы SOLID**: Чистая архитектура с разделением ответственности
- **Полное тестовое покрытие**: Юнит и интеграционные тесты
- **Валидация данных**: Проверка корректности данных перед экспортом
- **Обработка ошибок**: Graceful handling некорректных данных
- **Настраиваемый**: Множество опций конфигурации

## Поддерживаемые форматы

### Ren'Py ✅

- Экспорт переменных с объявлениями
- Поддержка всех типов операций с переменными
- Генерация условий (вероятности, сравнения, happened/not_happened)
- Создание меню выборов
- Автоматическая генерация README файла
- Поддержка кириллических имён переменных

### Godot — Dialogue Manager (Useless Tycoon) ✅

`ExportFormat.DIALOGUE_MANAGER`, `DialogueManagerCodeGenerator`, один файл `.dialogue` (Dialogue Manager 4.2, отступ — TAB).
Вызовы идут в `StoryBridge` игры (`state`, `flag`, `set_flag`, `effect`, `chance`, `scene`, `vars`, `stage`).

| Go Flow | `.dialogue` |
|---|---|
| стартовый узел | `~ start` + `=> <cue>` |
| нарративный узел | `~ <slug(title)>` (транслит, дедуп `_2`; без заголовка — `n_<id8>`; `start`/`end` зарезервированы), текст построчно как есть, в конце `=> <cue>` или `=> END` |
| `data.stage` нарратива | в начале cue по порядку: `do stage.clear()` → `stage.bg(id, t)` → `stage.hide(slot, t)` → `stage.move(from, to, t)` → `stage.show(slot, character, expression, outfit, t)` → `stage.cg(id, t)` / `stage.clear_cg()` (`cg: null`); незаданные хвостовые аргументы опускаются (дефолты GDScript), промежуточные — `""` |
| `stage.speaker` | строкам без явного `Имя: ` и не являющимся синтаксисом DM (`do`, `set`, `if`/`elif`/`else`, `=>`, `#`, `- `, отступ…) добавляется `<имя>: `; имя — из манифеста, затем из сущностей проекта, иначе id |
| `stage.scene` | `do scene("id")` после текста и операций, перед переходом |
| выборы | `- текст [if усл /]`, тело с отступом: операции + `=> <cue>` |
| прямые связи с условиями | `if` / `elif` / `else` с переходами (без безусловной связи — `else => END`) |
| игровой ключ: с манифестом — `game_keys[].key`; без — `<module>.<key>`, module ∈ relationships, household, uselessness, success_threat, inventory, hero | addition/subtract числа → `do effect({"<key>": ±float})`; чтение → `state("<key>", <начальное>)` (нативный `Object.get` в DM принимает 1 аргумент); прочие операции — предупреждение экспорта, операция пропускается |
| `flags.<x>` | override → `do set_flag("x", v)`, invert → `do set_flag("x", not flag("x"))`; чтение → `flag("x")` |
| прочие переменные (локальные) | `set vars["<name>"] = …`, чтение `vars.get("<name>", <начальное>)` |
| вероятность | `chance(p)` (p в 0..1; `randf()` в Dialogue Manager недоступен) |
| узел был / не был | `vars.get("seen.<cue>", false)`; цель условия в начале пишет `set vars["seen.<cue>"] = true` |

Ограничения: если у узла есть и выборы, и прямые связи, прямые связи игнорируются (предупреждение);
у игровых ключей поддерживается только числовая константа как цель операции.

**Манифест игры** (`src/services/gameManifest`, пишется Godot в `narrative/game_manifest.json`, schema v1,
лишние/отсутствующие поля допустимы): `ExportConfig.manifest` включает распознавание игровых ключей по `game_keys`
(дефолт `state()` — `initial` из манифеста; `writable: false` → операция пропускается с предупреждением;
`<module>.x` вне манифеста → локальная переменная + предупреждение) и проверку id персонажей/эмоций/костюмов/фонов/CG/слотов/сцен/флагов
(неизвестные → предупреждения). `syncVariablesFromManifest(variables, manifest)` добавляет недостающие игровые ключи как переменные
(`source: 'game'`, описание `[game] <module>`), обновляет тип/начальное значение существующих и никогда не удаляет пользовательские.

**CLI** (`scripts/export-dialogue.ts`):
`npm run export:dialogue -- --project-dir <dir> --out <godot>/content/dialogue [--manifest <godot>/narrative/game_manifest.json] [--check]`.
`<dir>/<slug>/project.json` — документ проекта локальной редакции (`{format, name, graph: {timelines, timelinesMetadata}, entities}`)
или JSON-экспорт Go Flow (`{title, data: {timelines}}`). Один таймлайн → `<slug>.dialogue`, несколько → `<slug>_<timeline-slug>.dialogue`.
`--check` ничего не пишет и завершается с кодом 1, если какой-то файл отсутствует или отличается (контроль дрейфа в CI).

Фикстуры для Godot-тестов (`tests/fixtures/goflow/sample_project.dialogue` и `sample_project/project.json`, источник — `exporters/data/sampleProject.ts`):
`DM_FIXTURE_DIR=<godot>/tests/fixtures/goflow npx jest projectDocument -t "sample project"`.

## Быстрый старт

```typescript
import {ExportServiceFactory} from './services/ExportService';
import {ExportFormat} from './services/interfaces/exportInterfaces';

// Создание сервиса
const exportService = ExportServiceFactory.create();

// Получение конфигурации по умолчанию
const config = exportService.getDefaultConfig(ExportFormat.RENPY);

// Экспорт истории
const result = await exportService.exportStory(storyData, config);

if (result.success) {
  console.log('Экспорт выполнен успешно!');
  console.log('Файл:', result.metadata?.filename);
  console.log('Содержимое:', result.content);
} else {
  console.error('Ошибки:', result.errors);
}
```

## Архитектура

### Основные компоненты

1. **ExportService** - Основной сервис, координирующий процесс экспорта
2. **StoryProcessor** - Обработка и валидация данных истории
3. **ICodeGenerator** - Интерфейс для генераторов кода конкретных форматов
4. **RenpyCodeGenerator** - Генератор кода для Ren'Py

### Диаграмма компонентов

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   ExportService │───▶│  StoryProcessor  │───▶│ ExportableStory │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                                               │
         ▼                                               ▼
┌─────────────────┐                            ┌─────────────────┐
│ ICodeGenerator  │◀───────────────────────────│   ExportResult  │
└─────────────────┘                            └─────────────────┘
         △
         │
┌─────────────────┐
│RenpyCodeGenerator│
└─────────────────┘
```

## Конфигурация

### ExportConfig

```typescript
interface ExportConfig {
  format: ExportFormat; // Формат экспорта
  includeComments: boolean; // Включать комментарии
  minifyOutput: boolean; // Минифицировать вывод
  generateReadme: boolean; // Генерировать README
  customVariablePrefix?: string; // Префикс для переменных
  encoding?: 'utf-8' | 'ascii'; // Кодировка файла
  indentSize?: number; // Размер отступа
}
```

### Примеры конфигурации

```typescript
// Базовая конфигурация
const config = exportService.getDefaultConfig(ExportFormat.RENPY);

// Кастомная конфигурация
const customConfig = {
  format: ExportFormat.RENPY,
  includeComments: false,
  generateReadme: false,
  customVariablePrefix: 'story_',
  indentSize: 2
};
```

## Добавление новых форматов

### 1. Создание генератора

```typescript
export class MyFormatGenerator implements ICodeGenerator {
  getSupportedFormat(): ExportFormat {
    return ExportFormat.MY_FORMAT;
  }

  getFileExtension(): string {
    return '.myformat';
  }

  generateCode(story: ExportableStory, config: ExportConfig): string {
    // Логика генерации кода
  }

  generateReadme(story: ExportableStory, config: ExportConfig): string {
    // Логика генерации README
  }
}
```

### 2. Регистрация генератора

```typescript
const exportService = ExportServiceFactory.create();
exportService.registerCodeGenerator(new MyFormatGenerator());
```

## Обработка данных

### StoryProcessor

Обрабатывает сложную многослойную структуру данных Go Flow и преобразует её в плоскую структуру для экспорта:

- **Разворачивание слоев**: Объединяет узлы и связи из всех слоев
- **Валидация**: Проверяет корректность данных
- **Очистка**: Удаляет невалидные связи
- **Поиск стартового узла**: Определяет точку входа в историю

### Обработка ошибок

Сервис gracefully обрабатывает различные типы ошибок:

- Невалидные связи между узлами
- Некорректные имена переменных
- Отсутствующие узлы
- Циклические зависимости

## Ren'Py специфика

### Конвертация переменных

| Go Flow | Ren'Py | Пример                    |
| ------- | ------ | ------------------------- |
| integer | int    | `default score = 100`     |
| float   | float  | `default health = 95.5`   |
| boolean | bool   | `default has_key = True`  |
| string  | str    | `default name = "Player"` |
| percent | float  | `default chance = 0.75`   |

### Операции с переменными

| Операция   | Go Flow  | Ren'Py              |
| ---------- | -------- | ------------------- |
| Присвоение | override | `$ score = 100`     |
| Сложение   | addition | `$ score += 10`     |
| Вычитание  | subtract | `$ health -= 5`     |
| Умножение  | multiply | `$ damage *= 2`     |
| Деление    | divide   | `$ speed /= 2`      |
| Инверсия   | invert   | `$ flag = not flag` |

### Условия

```python
# Вероятность
if renpy.random.randint(0, 99) < 50:
    "Удача!"

# Сравнение переменных
if score >= 100:
    "Победа!"

# Проверка посещения узла
if node_happened:
    "Уже был здесь"
```

## Тестирование

### Запуск тестов

```bash
# Все тесты экспорта
npm test -- --testPathPattern="Export"

# Только юнит тесты
npm test -- --testPathPattern="ExportService.test"

# Только интеграционные тесты
npm test -- --testPathPattern="RenpyExport.integration.test"
```

### Структура тестов

- **Юнит тесты**: Тестируют отдельные компоненты
- **Интеграционные тесты**: Тестируют полный workflow на реальных данных
- **Тесты валидации**: Проверяют обработку ошибок

## Примеры использования

### Базовый экспорт

```typescript
const exportService = ExportServiceFactory.create();
const config = exportService.getDefaultConfig(ExportFormat.RENPY);
const result = await exportService.exportStory(storyData, config);
```

### Экспорт с кастомными настройками

```typescript
const config = {
  format: ExportFormat.RENPY,
  includeComments: true,
  generateReadme: true,
  customVariablePrefix: 'game_',
  indentSize: 2
};

const result = await exportService.exportStory(storyData, config);
```

### Обработка результата

```typescript
if (result.success) {
  // Сохранение файла
  const filename = result.metadata?.filename || 'story.rpy';
  fs.writeFileSync(filename, result.content);

  // Сохранение README
  if (result.metadata?.readmeContent) {
    fs.writeFileSync('README.md', result.metadata.readmeContent);
  }

  // Логирование статистики
  console.log(`Экспортировано ${result.stats.totalNodes} узлов`);
  console.log(`Переменных: ${result.stats.variables}`);
  console.log(`Операций: ${result.stats.operations}`);
} else {
  console.error('Ошибки экспорта:');
  result.errors?.forEach((error) => console.error(`- ${error}`));
}
```

## Файловая структура

```
src/services/
├── interfaces/
│   └── exportInterfaces.ts     # Интерфейсы и типы
├── implementations/
│   ├── StoryProcessor.ts       # Обработка данных
│   └── RenpyCodeGenerator.ts   # Генератор Ren'Py
├── examples/
│   └── exportExample.ts       # Примеры использования
├── __tests__/
│   ├── ExportService.test.ts   # Юнит тесты
│   └── RenpyExport.integration.test.ts # Интеграционные тесты
├── ExportService.ts           # Основной сервис
├── export_test_flow.json      # Тестовые данные
└── renpy-story.rpy           # Эталонный результат
```

## Лицензия

Этот сервис является частью проекта Go Flow и наследует его лицензию.

## Поддержка

При возникновении проблем:

1. Проверьте тесты: `npm test -- --testPathPattern="Export"`
2. Изучите примеры в `examples/exportExample.ts`
3. Проверьте логи валидации в консоли
4. Создайте issue с подробным описанием проблемы
