import express, { NextFunction, Request, Response } from "express";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { logger } from "./logger.js";
import { normalizeSupplierProduct } from "./productMapper.js";
import { SupplierApi } from "./supplierApi.js";
import { SupplierDataRepository } from "./supplierDataRepository.js";
import { WorkerController } from "./workerController.js";

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
    res.json({ ...worker.status(), intervalHours: await worker.getIntervalHours() });
  }));

  app.post("/api/worker/start", asyncJson(async (_req, res) => {
    await worker.start();
    res.json({ ok: true, status: worker.status() });
  }));

  app.post("/api/worker/stop", asyncJson(async (_req, res) => {
    worker.stop();
    res.json({ ok: true, status: worker.status() });
  }));

  app.post("/api/worker/settings", asyncJson(async (req, res) => {
    await worker.setIntervalHours(Number(req.body.intervalHours));
    res.json({ ok: true, status: worker.status() });
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

const adminHtml = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Supplier Sync Admin</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1f2937; }
    header { background: #111827; color: white; padding: 16px 24px; }
    main { padding: 20px; max-width: 1280px; margin: auto; }
    section { background: white; border: 1px solid #d7dce2; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    button { padding: 8px 12px; border: 1px solid #aab2bd; border-radius: 6px; background: #fff; cursor: pointer; }
    button.primary { background: #14532d; color: white; border-color: #14532d; }
    button.danger { background: #7f1d1d; color: white; border-color: #7f1d1d; }
    button.loading { opacity: 0.7; cursor: wait; }
    button:disabled { cursor: wait; }
    input[type="number"] { width: 90px; padding: 6px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .tree ul { list-style: none; margin: 0 0 0 24px; padding: 0; }
    .node { display: grid; grid-template-columns: 28px minmax(260px, 1fr) 130px; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid #eef1f4; }
    .toggle { width: 24px; height: 24px; padding: 0; line-height: 1; }
    .toggle.empty { visibility: hidden; }
    li.collapsed > ul { display: none; }
    .muted { color: #6b7280; }
    pre { white-space: pre-wrap; background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; max-height: 260px; overflow: auto; }
  </style>
</head>
<body>
  <header><h1>Supplier Sync Admin</h1></header>
  <main>
    <section>
      <h2>Категории</h2>
      <div class="row">
        <button id="fetchCategories">Получить категории поставщика</button>
        <button class="primary" id="saveCategories">Сохранить выбор и наценки</button>
      </div>
      <p class="muted">Выбор родительской категории включает все дочерние. Наценка может быть отрицательной.</p>
      <div id="categories" class="tree"></div>
    </section>
    <section>
      <h2>Загрузка товаров</h2>
      <div class="row">
        <button id="fetchProducts">Получить товары и сохранить в БД</button>
        <button class="primary" id="runSync">Загрузить выбранные товары в Webasyst</button>
      </div>
    </section>
    <section>
      <h2>Worker</h2>
      <div class="row">
        <button id="refreshWorker">Обновить статус</button>
        <button class="primary" id="startWorker">Запустить</button>
        <button class="danger" id="stopWorker">Остановить</button>
        <label>Частота, часов <input id="intervalHours" type="number" step="0.1" min="0.1"></label>
        <button id="saveInterval">Сохранить частоту</button>
      </div>
      <pre id="workerStatus"></pre>
    </section>
    <section>
      <h2>Лог действий</h2>
      <pre id="log"></pre>
    </section>
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
        esc(node.path.join(' / ')) + '</label><label>Наценка % <input type="number" step="0.01" data-markup="' + esc(node.supplierCategoryKey) + '" value="' + (node.markupPercent ?? '') + '"></label></div>' +
        renderTree(node.children || []) + '</li>').join('') + '</ul>';
    }
    function bindCategoryTree() {
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
      document.querySelectorAll('#categories .toggle').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          li.classList.toggle('collapsed');
          button.textContent = li.classList.contains('collapsed') ? '▸' : '▾';
        });
      });
      document.querySelectorAll('#categories [data-key]').forEach(updateParentChecks);
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
        return { supplierCategoryKey: key, enabled: checkbox.checked, markupPercent: rawMarkup === '' ? null : Number(rawMarkup) };
      });
    }
    async function refreshWorker() {
      const data = await api('/api/worker/status');
      document.getElementById('workerStatus').textContent = JSON.stringify(data, null, 2);
      document.getElementById('intervalHours').value = data.intervalHours;
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
    document.getElementById('saveInterval').onclick = () => withLoading('saveInterval', 'Сохраняем...', async () => { log(await api('/api/worker/settings', { method: 'POST', body: JSON.stringify({ intervalHours: Number(document.getElementById('intervalHours').value) }) })); await refreshWorker(); });
    loadCategories().then(refreshWorker).catch(log);
  </script>
</body>
</html>`;

main().catch((error) => {
  logger.error("Admin UI failed", error);
  process.exitCode = 1;
});
