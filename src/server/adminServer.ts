import express, { NextFunction, Request, Response } from "express";
import { SupplierApi } from "../api/supplierApi.js";
import { loadConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { createDb } from "../db/db.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { normalizeSupplierProduct } from "../sync/productMapper.js";
import { WorkerController } from "../sync/workerController.js";

const config = loadConfig();
const worker = new WorkerController(config);

async function main(): Promise<void> {
  if (!config.database.enabled) {
    throw new Error("Admin UI requires MYSQL_ENABLED=true");
  }
  if (!config.admin.password) {
    throw new Error("Admin UI requires ADMIN_PASSWORD");
  }

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(authMiddleware);

  app.get("/", (_req, res) => {
    res.type("html").send(adminHtml);
  });

  app.get("/api/categories", asyncJson(async (_req, res) => {
    const repo = new SupplierDataRepository(createDb(config));
    try {
      res.json({ categories: await repo.getCategorySettingsTree() });
    } finally {
      await repo.destroy();
    }
  }));

  app.post("/api/categories/fetch", asyncJson(async (_req, res) => {
    const supplierApi = new SupplierApi(config);
    const repo = new SupplierDataRepository(createDb(config));
    try {
      const categories = await supplierApi.getCategories();
      await repo.saveSnapshot(categories, []);
      res.json({ ok: true, categories: categories.length });
    } finally {
      await repo.destroy();
    }
  }));

  app.post("/api/categories/settings", asyncJson(async (req, res) => {
    const repo = new SupplierDataRepository(createDb(config));
    try {
      await repo.updateCategorySettings(req.body.settings ?? []);
      res.json({ ok: true });
    } finally {
      await repo.destroy();
    }
  }));

  app.post("/api/supplier/fetch-products", asyncJson(async (_req, res) => {
    const supplierApi = new SupplierApi(config);
    const repo = new SupplierDataRepository(createDb(config));
    try {
      const categories = await supplierApi.getCategories();
      const products = (await supplierApi.getProducts(config.importLimit)).map(normalizeSupplierProduct);
      await repo.saveSnapshot(categories, products);
      res.json({ ok: true, products: products.length });
    } finally {
      await repo.destroy();
    }
  }));

  app.post("/api/sync/run", asyncJson(async (_req, res) => {
    const stats = await worker.runNow("admin-manual");
    res.json({ ok: true, stats });
  }));

  app.get("/api/worker/status", asyncJson(async (_req, res) => {
    res.json({ ...(await worker.status()), intervalHours: await worker.getIntervalHours() });
  }));

  app.post("/api/worker/start", asyncJson(async (_req, res) => {
    await worker.start();
    res.json({ ok: true, status: await worker.status() });
  }));

  app.post("/api/worker/stop", asyncJson(async (_req, res) => {
    worker.stop();
    res.json({ ok: true, status: await worker.status() });
  }));

  app.post("/api/worker/settings", asyncJson(async (req, res) => {
    await worker.setIntervalHours(Number(req.body.intervalHours));
    await worker.setStartTime(req.body.startTime);
    res.json({ ok: true, status: await worker.status() });
  }));

  app.get("/api/telegram/settings", asyncJson(async (_req, res) => {
    const repo = new SupplierDataRepository(createDb(config));
    try {
      const storedChatIds = parseChatIds(await repo.getSetting("telegram_chat_ids"));
      res.json({
        botConfigured: Boolean(config.telegram.botToken),
        chatIds: storedChatIds.length > 0 ? storedChatIds : config.telegram.chatIds,
        source: storedChatIds.length > 0 ? "database" : "env"
      });
    } finally {
      await repo.destroy();
    }
  }));

  app.post("/api/telegram/settings", asyncJson(async (req, res) => {
    const chatIds = parseChatIds(String(req.body.chatIds ?? ""));
    const repo = new SupplierDataRepository(createDb(config));
    try {
      await repo.setSetting("telegram_chat_ids", chatIds.join(","));
      res.json({ ok: true, chatIds });
    } finally {
      await repo.destroy();
    }
  }));

  app.get("/api/sync/runs", asyncJson(async (_req, res) => {
    const repo = new SupplierDataRepository(createDb(config));
    try {
      res.json({ runs: await repo.getLastSyncRuns(20) });
    } finally {
      await repo.destroy();
    }
  }));

  app.listen(config.admin.port, () => {
    logger.info("Admin UI started", { port: config.admin.port });
  });
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const expected = `Basic ${Buffer.from(`admin:${config.admin.password}`).toString("base64")}`;
  if (header === expected) {
    next();
    return;
  }
  res.setHeader("WWW-Authenticate", "Basic realm=\"supplier-sync\"");
  res.status(401).send("Authentication required");
}

function asyncJson(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function parseChatIds(value?: string): string[] {
  return (value ?? "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const adminHtml = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Supplier Sync Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f4f6f8; color: #172033; }
    header { background: #16202f; color: white; padding: 18px 28px; border-bottom: 3px solid #2f7d57; }
    header h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    main { padding: 22px; max-width: 1360px; margin: auto; }
    section { background: white; border: 1px solid #d9e0e7; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
    section h2 { margin: 0 0 12px; font-size: 17px; }
    button { padding: 8px 12px; border: 1px solid #aab5c2; border-radius: 6px; background: #fff; cursor: pointer; color: #172033; }
    button:hover { background: #f3f6f8; }
    button.primary { background: #17613f; color: white; border-color: #17613f; }
    button.primary:hover { background: #124f34; }
    button.danger { background: #8a2424; color: white; border-color: #8a2424; }
    button.danger:hover { background: #731d1d; }
    button.loading { opacity: 0.7; cursor: wait; }
    button:disabled { cursor: wait; }
    input, textarea { border: 1px solid #b8c2cc; border-radius: 6px; background: #fff; color: #172033; }
    input[type="number"], input[type="time"] { width: 100px; padding: 7px; }
    textarea { width: 100%; min-height: 86px; padding: 8px; resize: vertical; font: inherit; }
    .dashboard { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
    .side-stack { display: grid; gap: 16px; }
    .markup-label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .markup-control { display: inline-flex; align-items: center; gap: 2px; }
    .markup-control input { width: 72px; padding: 6px; }
    .markup-control button { width: 26px; height: 28px; padding: 0; line-height: 1; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .field { display: grid; gap: 6px; margin-bottom: 10px; }
    .field label { font-size: 13px; font-weight: 600; color: #3c4657; }
    .tree ul { list-style: none; margin: 0 0 0 24px; padding: 0; }
    .node { display: grid; grid-template-columns: 28px minmax(240px, 1fr) 210px; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid #eef1f4; }
    .toggle { width: 24px; height: 24px; padding: 0; line-height: 1; }
    .toggle.empty { visibility: hidden; }
    li.collapsed > ul { display: none; }
    .muted { color: #6b7280; }
    .status-line { min-height: 20px; font-size: 13px; color: #536171; }
    pre { white-space: pre-wrap; background: #101827; color: #e2e8f0; padding: 12px; border-radius: 8px; max-height: 260px; overflow: auto; }
    @media (max-width: 980px) { .dashboard { grid-template-columns: 1fr; } .node { grid-template-columns: 28px minmax(180px, 1fr); } .markup-label { grid-column: 2; } }
  </style>
</head>
<body>
  <header><h1>Supplier Sync Admin</h1></header>
  <main>
    <div class="dashboard">
      <section>
        <h2>Категории</h2>
        <div class="row">
          <button id="fetchCategories">Получить категории поставщика</button>
          <button class="primary" id="saveCategories">Сохранить выбор и наценки</button>
        </div>
        <p class="muted">Выбор родительской категории включает все дочерние. Наценка может быть отрицательной.</p>
        <div id="categories" class="tree"></div>
      </section>
      <div class="side-stack">
        <section>
          <h2>Загрузка товаров</h2>
          <div class="row">
            <button id="fetchProducts">Получить товары</button>
            <button class="primary" id="runSync">Загрузить в Webasyst</button>
          </div>
        </section>
        <section>
          <h2>Worker</h2>
          <div class="row">
            <button id="refreshWorker">Обновить статус</button>
            <button class="primary" id="startWorker">Запустить</button>
            <button class="danger" id="stopWorker">Остановить</button>
          </div>
          <div class="row" style="margin-top: 10px;">
            <label>Частота, часов <input id="intervalHours" type="number" step="0.1" min="0.1"></label>
            <label>Время старта <input id="startTime" type="time"></label>
            <button id="saveInterval">Сохранить</button>
          </div>
          <pre id="workerStatus"></pre>
        </section>
        <section>
          <h2>Telegram</h2>
          <div class="field">
            <label for="telegramChatIds">Chat ID получателей</label>
            <textarea id="telegramChatIds" placeholder="1763017158&#10;123456789"></textarea>
          </div>
          <div class="row">
            <button id="refreshTelegram">Обновить</button>
            <button class="primary" id="saveTelegram">Сохранить chat_id</button>
          </div>
          <div id="telegramStatus" class="status-line"></div>
        </section>
        <section>
          <h2>Лог действий</h2>
          <pre id="log"></pre>
        </section>
      </div>
    </div>
  </main>
  <script>
    const log = (value) => {
      document.getElementById('log').textContent = new Date().toLocaleString() + ' ' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n' + document.getElementById('log').textContent;
    };
    async function api(path, options = {}) {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function withLoading(buttonId, label, action) {
      const button = document.getElementById(buttonId);
      const previousText = button.textContent;
      button.disabled = true;
      button.classList.add('loading');
      button.textContent = label || 'Выполняется...';
      try {
        return await action();
      } catch (error) {
        log(error.message || String(error));
        throw error;
      } finally {
        button.textContent = previousText;
        button.classList.remove('loading');
        button.disabled = false;
      }
    }
    async function loadCategories() {
      const data = await api('/api/categories');
      document.getElementById('categories').innerHTML = renderTree(data.categories);
      bindCategoryTree();
    }
    function renderTree(nodes) {
      if (!nodes || nodes.length === 0) return '<ul></ul>';
      return '<ul>' + nodes.map((node) => '<li class="' + ((node.children || []).length ? 'collapsed' : '') + '">' +
        '<div class="node"><button type="button" class="toggle ' + ((node.children || []).length ? '' : 'empty') + '">+</button><label><input type="checkbox" data-key="' + esc(node.supplierCategoryKey) + '" ' + (node.enabled ? 'checked' : '') + '> ' +
        esc(node.path.join(' / ')) + '</label><label class="markup-label">Наценка % <span class="markup-control"><input type="text" inputmode="decimal" data-markup="' + esc(node.supplierCategoryKey) + '" value="' + (node.markupPercent ?? '') + '"><button type="button" data-markup-step="' + esc(node.supplierCategoryKey) + '" data-step="1">▲</button><button type="button" data-markup-step="' + esc(node.supplierCategoryKey) + '" data-step="-1">▼</button></span></label></div>' +
        renderTree(node.children || []) + '</li>').join('') + '</ul>';
    }
    function bindCategoryTree() {
      applyInitialInheritedChecks();
      applyInitialInheritedMarkups();
      document.querySelectorAll('#categories [data-key]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const li = checkbox.closest('li');
          li.querySelectorAll('ul [data-key]').forEach((child) => {
            child.checked = checkbox.checked;
            child.indeterminate = false;
          });
          updateParentChecks(checkbox);
        });
      });
      document.querySelectorAll('#categories [data-markup]').forEach((input) => {
        input.addEventListener('input', () => {
          input.value = sanitizeMarkupInput(input.value);
          const li = input.closest('li');
          li.querySelectorAll('ul [data-markup]').forEach((child) => {
            child.value = input.value;
          });
          clearParentMarkups(input);
        });
      });
      document.querySelectorAll('#categories [data-markup-step]').forEach((button) => {
        button.addEventListener('click', () => {
          const key = button.getAttribute('data-markup-step');
          const input = document.querySelector('[data-markup="' + cssEscape(key) + '"]');
          const current = parseMarkupNumber(sanitizeMarkupInput(input.value)) ?? 0;
          input.value = String(Math.max(-100, current + Number(button.getAttribute('data-step'))));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      document.querySelectorAll('#categories .toggle').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          li.classList.toggle('collapsed');
          button.textContent = li.classList.contains('collapsed') ? '▸' : '▾';
        });
      });
      document.querySelectorAll('#categories [data-key]').forEach(updateParentChecks);
    }
    function applyInitialInheritedChecks() {
      document.querySelectorAll('#categories [data-key]:checked').forEach((checkbox) => {
        checkbox.closest('li').querySelectorAll('ul [data-key]').forEach((child) => {
          child.checked = true;
          child.indeterminate = false;
        });
      });
    }
    function applyInitialInheritedMarkups() {
      document.querySelectorAll('#categories [data-markup]').forEach((input) => {
        const parentMarkup = findNearestParentMarkup(input);
        if (input.value.trim() === '' && parentMarkup) {
          input.value = parentMarkup;
        }
      });
    }
    function findNearestParentMarkup(input) {
      let parentLi = input.closest('ul')?.closest('li');
      while (parentLi) {
        const parentInput = parentLi.querySelector(':scope > .node [data-markup]');
        const value = parentInput?.value.trim();
        if (value !== '') return value;
        parentLi = parentLi.closest('ul')?.closest('li');
      }
      return '';
    }
    function clearParentMarkups(input) {
      let parentLi = input.closest('ul')?.closest('li');
      while (parentLi) {
        const parentInput = parentLi.querySelector(':scope > .node [data-markup]');
        if (parentInput) parentInput.value = '';
        parentLi = parentLi.closest('ul')?.closest('li');
      }
    }
    function updateParentChecks(fromCheckbox) {
      let parentLi = fromCheckbox.closest('ul')?.closest('li');
      while (parentLi) {
        const parentCheckbox = parentLi.querySelector(':scope > .node [data-key]');
        const childCheckboxes = [...parentLi.querySelectorAll(':scope > ul [data-key]')];
        const checked = childCheckboxes.filter((item) => item.checked).length;
        parentCheckbox.checked = childCheckboxes.length > 0 && checked === childCheckboxes.length;
        parentCheckbox.indeterminate = checked > 0 && checked < childCheckboxes.length;
        parentLi = parentLi.closest('ul')?.closest('li');
      }
    }
    function collectSettings() {
      return [...document.querySelectorAll('[data-key]')].map((checkbox) => {
        const key = checkbox.getAttribute('data-key');
        const markupInput = document.querySelector('[data-markup="' + cssEscape(key) + '"]');
        const rawMarkup = markupInput.value.trim();
        const markupPercent = rawMarkup === '' || rawMarkup === '-' ? null : parseMarkupValue(rawMarkup);
        if (markupPercent === undefined) throw new Error('Некорректная наценка: ' + rawMarkup);
        return { supplierCategoryKey: key, enabled: checkbox.checked, markupPercent };
      });
    }
    function parseMarkupValue(value) {
      const parsed = parseMarkupNumber(value);
      if (parsed === null) return null;
      if (!Number.isFinite(parsed) || parsed < -100) return undefined;
      return parsed;
    }
    function parseMarkupNumber(value) {
      const normalized = String(value).trim().replace(/[−–—]/g, '-').replace(',', '.');
      if (normalized === '' || normalized === '-') return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    function sanitizeMarkupInput(value) {
      let normalized = String(value).replace(/[−–—]/g, '-').replace(/\./g, ',').replace(/[^\d,-]/g, '');
      const negative = normalized.includes('-');
      normalized = normalized.replace(/-/g, '');
      const commaIndex = normalized.indexOf(',');
      if (commaIndex !== -1) {
        normalized = normalized.slice(0, commaIndex + 1) + normalized.slice(commaIndex + 1).replace(/,/g, '');
      }
      normalized = (negative ? '-' : '') + normalized;
      const parsed = parseMarkupNumber(normalized);
      if (parsed !== undefined && parsed !== null && parsed < -100) return '-100';
      return normalized;
    }
    async function refreshWorker() {
      const data = await api('/api/worker/status');
      document.getElementById('workerStatus').textContent = JSON.stringify(data, null, 2);
      document.getElementById('intervalHours').value = data.intervalHours;
      document.getElementById('startTime').value = data.startTime || '';
    }
    async function refreshTelegram() {
      const data = await api('/api/telegram/settings');
      document.getElementById('telegramChatIds').value = (data.chatIds || []).join('\n');
      document.getElementById('telegramStatus').textContent = 'Бот: ' + (data.botConfigured ? 'настроен' : 'не настроен') + ' · источник chat_id: ' + data.source;
    }
    function collectTelegramChatIds() {
      return document.getElementById('telegramChatIds').value
        .split(/[,\n;]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .join(',');
    }
    const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const cssEscape = (value) => String(value).replace(/["\\]/g, '\\$&');
    document.getElementById('fetchCategories').onclick = () => withLoading('fetchCategories', 'Получаем...', async () => { log(await api('/api/categories/fetch', { method: 'POST' })); await loadCategories(); });
    document.getElementById('saveCategories').onclick = () => withLoading('saveCategories', 'Сохраняем...', async () => { log(await api('/api/categories/settings', { method: 'POST', body: JSON.stringify({ settings: collectSettings() }) })); });
    document.getElementById('fetchProducts').onclick = () => withLoading('fetchProducts', 'Загружаем...', async () => { log(await api('/api/supplier/fetch-products', { method: 'POST' })); });
    document.getElementById('runSync').onclick = () => withLoading('runSync', 'Загружаем в Webasyst...', async () => { log(await api('/api/sync/run', { method: 'POST' })); await refreshWorker(); });
    document.getElementById('refreshWorker').onclick = () => withLoading('refreshWorker', 'Обновляем...', refreshWorker);
    document.getElementById('startWorker').onclick = () => withLoading('startWorker', 'Запускаем...', async () => { log(await api('/api/worker/start', { method: 'POST' })); await refreshWorker(); });
    document.getElementById('stopWorker').onclick = () => withLoading('stopWorker', 'Останавливаем...', async () => { log(await api('/api/worker/stop', { method: 'POST' })); await refreshWorker(); });
    document.getElementById('saveInterval').onclick = () => withLoading('saveInterval', 'Сохраняем...', async () => { log(await api('/api/worker/settings', { method: 'POST', body: JSON.stringify({ intervalHours: Number(document.getElementById('intervalHours').value), startTime: document.getElementById('startTime').value }) })); await refreshWorker(); });
    document.getElementById('refreshTelegram').onclick = () => withLoading('refreshTelegram', 'Обновляем...', refreshTelegram);
    document.getElementById('saveTelegram').onclick = () => withLoading('saveTelegram', 'Сохраняем...', async () => { log(await api('/api/telegram/settings', { method: 'POST', body: JSON.stringify({ chatIds: collectTelegramChatIds() }) })); await refreshTelegram(); });
    Promise.all([loadCategories(), refreshWorker(), refreshTelegram()]).catch(log);
  </script>
</body>
</html>`;

main().catch((error) => {
  logger.error("Admin UI failed", error);
  process.exitCode = 1;
});
