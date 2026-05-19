# supplier-sync

## Admin UI

Веб-интерфейс управления импортом запускается командой:

```bash
npm run admin
```

После сборки:

```bash
npm run build
npm run admin:build
```

Через Docker:

```bash
docker compose up -d --build supplier-admin
```

Открыть:

```text
http://localhost:3000
```

Логин для Basic Auth:

```text
admin
```

Пароль задается в `.env`:

```dotenv
ADMIN_PORT=3000
ADMIN_PASSWORD=change-me
```

В интерфейсе можно:

- получить категории поставщика и сохранить их в БД;
- выбрать категории для загрузки;
- задать положительную или отрицательную наценку по категории;
- получить товары поставщика и сохранить их в БД;
- вручную запустить загрузку выбранных товаров в Webasyst;
- посмотреть статус worker;
- изменить частоту worker в БД;
- запустить или остановить worker.

Выбор родительской категории включает все дочерние категории.

## MySQL через Knex

Скрипт может сохранять категории и товары поставщика в MySQL. Включается через `.env`:

```dotenv
MYSQL_ENABLED=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=webasyst_import
MYSQL_USER=webasyst_import
MYSQL_PASSWORD=password
MYSQL_SSL=false
```

Если `MYSQL_ENABLED=false` или не заполнены `MYSQL_HOST`, `MYSQL_DATABASE`, `MYSQL_USER`, слой БД отключен и скрипт работает как раньше.

Перед сохранением данных нужно применить миграции:

```bash
npm run db:migrate
```

Откат последней миграции:

```bash
npm run db:rollback
```

Миграции создают таблицы:

- `supplier_categories`
- `supplier_products`

Данные сохраняются через upsert:

- категории по `supplier_category_key`;
- товары по `supplier_product_id`.

Сохранение выполняется в командах `npm run check:supplier`, `npm run dev`, `npm start`, `npm run worker`.

## Telegram-логи сверки поставщика

После каждого успешного получения и нормализации товаров поставщика скрипт может отправлять короткий отчет в Telegram. Сообщение отправляется на русском и содержит только статистику, без списка товаров. Для включения заполните:

```dotenv
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
TELEGRAM_CHAT_IDS=111111111,222222222
```

- `TELEGRAM_BOT_TOKEN` — токен бота от BotFather.
- `TELEGRAM_CHAT_IDS` — один или несколько chat ID через запятую.

Счетчик запросов хранится в `data/telegram-state.json`. Если токен или chat IDs не заполнены, Telegram-уведомления отключены.

## Автоматическая сверка по расписанию

Для постоянного процесса используйте worker:

```bash
npm run worker
```

После сборки:

```bash
npm run build
npm run worker:build
```

Частота сверки с поставщиком задается в часах:

```dotenv
SUPPLIER_SYNC_INTERVAL_HOURS=1
```

`1` означает сверку раз в час, `6` — раз в 6 часов, `0.5` — раз в 30 минут. Worker запускает первую сверку сразу после старта, затем повторяет ее с указанным интервалом.

## Проверка получения товаров поставщика без Webasyst

Одноразовый тестовый запуск, который обращается только к API поставщика и ничего не отправляет в Webasyst:

```bash
npm run check:supplier
```

После сборки:

```bash
npm run build
npm run check:supplier:build
```

Для ограничения количества товаров используйте:

```dotenv
IMPORT_LIMIT=10
```

Эта команда не читает и не меняет `data/product-map.json` и `data/category-map.json`. Для нее достаточно заполнить `SUPPLIER_API_URL`, `SUPPLIER_API_LOGIN`, `SUPPLIER_API_PASSWORD`.

## Синхронизация категорий поставщика

Корневая категория Webasyst `Под заказ` должна быть создана вручную. Скрипт не создает ее автоматически. Ее ID передается через:

```dotenv
WEBASYST_PREORDER_ROOT_CATEGORY_ID=123
```

Режим категорий задается переменной:

```dotenv
SUPPLIER_CATEGORY_MODE=single
```

Доступные режимы:

- `single` — все товары отправляются только в `WEBASYST_PREORDER_ROOT_CATEGORY_ID`.
- `mirror` — дерево категорий поставщика повторяется внутри `WEBASYST_PREORDER_ROOT_CATEGORY_ID`.

В режиме `mirror` цепочка поставщика вида:

```text
["Запчасти", "Фильтры", "Воздушные фильтры"]
```

будет создана в Webasyst как:

```text
Под заказ -> Запчасти -> Фильтры -> Воздушные фильтры
```

Соответствия категорий с Webasyst сохраняются в MySQL в полях `supplier_categories.webasyst_category_id` и `webasyst_synced_at`. Если `MYSQL_ENABLED=false`, используется fallback-файл `data/category-map.json`. Если поставщик отдает `category_id`, он используется как основной ключ; если ID нет, используется полный путь категории. При создании и обновлении категорий задается `status=1`; для родительских категорий `include_sub_categories=1`.

В `DRY_RUN=true` категории в Webasyst не создаются, а связи с Webasyst в MySQL или `data/category-map.json` не меняются. Скрипт только логирует, какие категории были бы созданы.

При создании или обновлении товара первым ID в `categories` передается конечная категория поставщика. В Webasyst это делает ее основной категорией товара.

Внешний Node.js/TypeScript-скрипт для синхронизации товаров из B2B API поставщика в облачный Webasyst Shop-Script. Скрипт не требует доступа к файловой системе Webasyst и работает через публичный Webasyst API.

## Что делает синхронизация

1. Авторизуется в API поставщика методом JSON-RPC `quickfox/auth/login`.
2. Получает дерево категорий из статики `/download/catalog/json/catalog_tree_9.json`.
3. Получает каталог товаров из статики `/download/catalog/json/products_9.json`.
4. Получает цены и наличие только активных товаров методом `platform/client_api/get_active_products`.
5. Получает характеристики 18+ товаров методом `platform/client_api/get_adult_products_characteristics`.
6. Получает URL изображений методом `platform/products_clients_images/read_new` батчами до 100 SKU.
7. Создает или обновляет товары в Webasyst методами `shop.product.add` и `shop.product.update`.
8. Для новых товаров загружает изображения через `shop.product.images.add`.
9. Хранит соответствия `external_id -> webasyst_product_id` в MySQL в полях `supplier_products.webasyst_product_id` и `webasyst_synced_at`; без MySQL используется fallback-файл `data/product-map.json`.

## Поля API поставщика

Используемые поля из `/download/catalog/json/products_9.json`:

- `sku` -> `SupplierProduct.id`, `SupplierProduct.sku`, SKU в Webasyst.
- `name` -> название товара.
- `part` -> характеристика `part`.
- `vendor` -> бренд и характеристика `brand`.
- `barcodes` -> первый штрихкод.
- `category` -> путь категории через `catalog_tree_9.json`.
- `has_image` -> признак, что нужно запросить изображения.
- `rrp` -> старая/зачеркнутая цена, если больше итоговой цены.
- `warranty`, `weight`, `volume`, `multiplicity` -> характеристики.

Используемые поля из `get_active_products`:

- `price` -> цена товара в рублях.
- `qty` -> приблизительный остаток для режима `PREORDER_STOCK_MODE=supplier` (`*` = 1, `**` = 10, `***` = 100).
- `nearest_logistic_center_qty`, `delivery_days`, `multiplicity` -> характеристики.

Используемые поля из `products_clients_images/read_new`:

- `url` -> скачивание изображения по `https://domain/<url>?size=original`.
- `priority` -> сортировка URL изображений.
- `deleted` -> удаленные изображения не используются.

Используемые поля из `get_adult_products_characteristics`:

- `Описание` -> описание товара.
- `Наименование` учитывается только как запасной источник названия.
- Остальные пары `name/value` добавляются в `features`.

Для обычных, не 18+ товаров документация не предусматривает endpoint характеристик.

## Авторизация и лимиты поставщика

- Авторизация: `POST https://domain/api/2` с JSON-RPC payload `login/password`, затем все JSON-RPC запросы передают `session`, а статика скачивается с cookie `session=<session>`.
- Список товаров и категории пагинации не имеют: это статические JSON-файлы.
- Конкретный товар по цене/остатку можно получить через `get_active_products` с фильтром `sku = ...`; основной импорт использует общий список активных товаров.
- Отдельный endpoint цен/остатков есть: `get_active_products`.
- Отдельный endpoint изображений есть: `products_clients_images/read_new`.
- Лимиты из документации: `login` 10/мин, дерево категорий 1/мин, список товаров 2/час, цены/остатки 10/час, изображения 2/сек, скачивание фото 5/сек.
- Ошибки JSON-RPC приходят как `success: false` и `message`; для статики при проблеме авторизации возможен HTTP 404.

## Установка

```bash
npm install
cp .env.example .env
```

На Windows вместо `cp` можно создать `.env` вручную на основе `.env.example`.

## Настройка `.env`

```dotenv
SUPPLIER_API_URL=https://supplier-b2b.example.com
SUPPLIER_API_LOGIN=login
SUPPLIER_API_PASSWORD=password

WEBASYST_API_URL=https://example.webasyst.cloud/api.php
WEBASYST_ACCESS_TOKEN=token

WEBASYST_DEFAULT_CATEGORY_ID=123
WEBASYST_PRODUCT_TYPE_ID=1
WEBASYST_CURRENCY=RUB

PRICE_MARKUP_PERCENT=0
IMPORT_LIMIT=10
DRY_RUN=true

APPEND_PREORDER_TEXT=false
PREORDER_TAG=под заказ
PREORDER_STOCK_MODE=null
PREORDER_STOCK_VALUE=999
```

`SUPPLIER_API_TOKEN` оставлен в примере окружения для совместимости с общей схемой, но в предоставленной документации поставщика токен не используется: авторизация выполняется логином и паролем.

## Товары под заказ

Каждый импортированный товар получает:

- тег из `PREORDER_TAG`;
- `status=1`;
- SKU с `available=1` и `status=1`;
- параметры:

```text
preorder=1
supplier_external_id=<sku поставщика>
supplier_source=external_api
```

Режим остатков:

- `PREORDER_STOCK_MODE=null` — остаток не передается;
- `PREORDER_STOCK_MODE=fixed` — передается `PREORDER_STOCK_VALUE`;
- `PREORDER_STOCK_MODE=supplier` — используется приблизительная интерпретация `qty`: `*`, `**`, `***`.

Если `APPEND_PREORDER_TEXT=true`, в конец описания добавляется текст:

```text
Товар доступен под заказ. Срок поставки уточняется после оформления заказа.
```

## Запуск DRY_RUN

```bash
npm run dev
```

При `DRY_RUN=true` запросы в Webasyst не отправляются, связи с Webasyst в MySQL или `data/product-map.json` не меняются. Скрипт только показывает, какие товары были бы созданы или обновлены.

## Запуск в Docker

Собрать образ:

```bash
docker compose build
```

Запустить с настройками из `.env`:

```bash
docker compose run --rm supplier-sync
```

Папка `data` примонтирована как volume для fallback-файлов и служебного состояния:

```yaml
./data:/app/data
```

Если `MYSQL_ENABLED=true`, связи товаров и категорий с Webasyst хранятся в MySQL, а JSON-карты не используются. Если MySQL отключен, fallback-файлы в `data` сохраняются на хосте и не пропадают после удаления контейнера.

Для тестового запуска оставьте в `.env`:

```dotenv
DRY_RUN=true
IMPORT_LIMIT=10
```

Для реального запуска:

```dotenv
DRY_RUN=false
```

## Реальный запуск

```bash
npm run build
DRY_RUN=false npm start
```

На Windows PowerShell:

```powershell
$env:DRY_RUN="false"; npm start
```

## Cron

С учетом лимитов поставщика каталог обновляется раз в сутки ночью, поэтому чаще одного раза в день запускать полный импорт обычно не нужно.

```cron
30 3 * * * cd /opt/supplier-sync && /usr/bin/npm start >> /var/log/supplier-sync.log 2>&1
```

Cron-вариант через Docker:

```cron
30 3 * * * cd /opt/supplier-sync && /usr/bin/docker compose run --rm supplier-sync >> /var/log/supplier-sync.log 2>&1
```

## Где менять маппинг

- Нормализация полей поставщика: `src/sync/productMapper.ts`, функция `normalizeSupplierProduct`.
- Маппинг в Webasyst: `src/sync/productMapper.ts`, функция `mapSupplierToWebasyst`.
- Запросы к поставщику и объединение статики/цен/картинок: `src/api/supplierApi.ts`.
- Методы Webasyst API и форма отправки: `src/api/webasystApi.ts`.

## Хранение связей с Webasyst

При `MYSQL_ENABLED=true` связи с Webasyst хранятся в БД:

- `supplier_products.webasyst_product_id`, `supplier_products.webasyst_synced_at`;
- `supplier_categories.webasyst_category_id`, `supplier_categories.webasyst_synced_at`.

Файлы `data/product-map.json` и `data/category-map.json` используются только как fallback, если MySQL отключен. В режиме с БД они не читаются и не изменяются.

Fallback-файл `data/product-map.json` создается автоматически, если отсутствует.

Формат:

```json
{
  "2881306": {
    "webasyst_product_id": 123,
    "sku": "2881306",
    "updated_at": "2026-05-18T12:00:00.000Z"
  }
}
```

Если JSON поврежден, скрипт останавливается и не затирает файл молча.
