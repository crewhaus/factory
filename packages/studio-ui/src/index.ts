/**
 * Catalog F4 `studio-ui` — Section 26 Studio.
 *
 * Vanilla TS module that exports an HTML string + a stand-alone JS
 * bundle the studio-server can serve at `/`. v0 ships a minimal
 * single-page app:
 *   - top nav: Specs · Wizard · Plugins
 *   - Specs: lists `/api/specs`, click to open the YAML in a textarea
 *     editor (no Monaco — vanilla `<textarea>` keeps deps tiny)
 *   - Wizard: walks `/api/wizard/start` → `/step` → `/compile` and
 *     POSTs to `/api/specs` to create the new spec
 *   - Plugins: lists `/api/plugins`
 *
 * Lit + Monaco land in a follow-up; v0 keeps the UI shipping-ready
 * without any client-side build complexity.
 */

export type RenderOptions = {
  /** Title shown in the page <title> + H1. Default "CrewHaus Studio". */
  readonly title?: string;
};

export function renderStudioHtml(opts: RenderOptions = {}): string {
  const title = opts.title ?? "CrewHaus Studio";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    header { padding: 16px 32px; background: #1d3a8a; color: white; }
    header h1 { margin: 0; font-size: 22px; }
    nav { padding: 12px 32px; background: #f3f4f6; display: flex; gap: 24px; }
    nav button { background: none; border: 0; font-size: 15px; cursor: pointer; padding: 4px 0; color: #1d3a8a; }
    nav button.active { font-weight: bold; border-bottom: 2px solid #1d3a8a; }
    main { padding: 24px 32px; }
    .specs-list { list-style: none; padding: 0; }
    .specs-list li { padding: 8px 12px; cursor: pointer; border: 1px solid #ddd; margin-bottom: 4px; border-radius: 4px; }
    .specs-list li:hover { background: #f9fafb; }
    textarea { width: 100%; height: 360px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    .pane { background: #fafafa; border: 1px solid #e5e7eb; padding: 16px; margin-top: 12px; border-radius: 4px; }
  </style>
</head>
<body>
  <header><h1>${title}</h1></header>
  <nav>
    <button id="tab-specs" class="active">Specs</button>
    <button id="tab-wizard">Wizard</button>
    <button id="tab-plugins">Plugins</button>
  </nav>
  <main>
    <section id="view-specs"></section>
    <section id="view-wizard" hidden></section>
    <section id="view-plugins" hidden></section>
  </main>
  <script type="module">
${getStudioJs()}
  </script>
</body>
</html>`;
}

/**
 * The standalone JS bundle. Exported separately so the studio-server
 * can also serve it from `/studio.js` if the embedding host wants
 * that.
 */
export function getStudioJs(): string {
  return `
const $ = (sel) => document.querySelector(sel);
const tabs = ['specs', 'wizard', 'plugins'];

function activate(name) {
  for (const t of tabs) {
    const btn = $('#tab-' + t);
    const view = $('#view-' + t);
    if (!btn || !view) continue;
    btn.classList.toggle('active', t === name);
    view.hidden = t !== name;
  }
  if (name === 'specs') renderSpecs();
  if (name === 'wizard') renderWizard();
  if (name === 'plugins') renderPlugins();
}

for (const t of tabs) {
  const btn = $('#tab-' + t);
  if (btn) btn.addEventListener('click', () => activate(t));
}

async function renderSpecs() {
  const view = $('#view-specs');
  if (!view) return;
  view.innerHTML = 'Loading…';
  try {
    const { specs } = await fetch('/api/specs').then((r) => r.json());
    if (specs.length === 0) {
      view.innerHTML = '<p>No specs yet. Use the Wizard tab to create one.</p>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'specs-list';
    for (const s of specs) {
      const li = document.createElement('li');
      li.textContent = s.name + ' (' + s.target + ')';
      li.addEventListener('click', () => openSpec(s.name));
      ul.appendChild(li);
    }
    view.replaceChildren(ul);
  } catch (err) {
    view.innerHTML = 'Error: ' + err;
  }
}

async function openSpec(name) {
  const view = $('#view-specs');
  if (!view) return;
  const { yaml } = await fetch('/api/specs/' + name).then((r) => r.json());
  view.innerHTML = '<h2>' + name + '</h2>';
  const ta = document.createElement('textarea');
  ta.value = yaml;
  view.appendChild(ta);
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const r = await fetch('/api/specs/' + name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: ta.value }),
    });
    save.textContent = r.ok ? 'Saved.' : 'Save failed';
    setTimeout(() => (save.textContent = 'Save'), 1500);
  });
  view.appendChild(save);
}

async function renderWizard() {
  const view = $('#view-wizard');
  if (!view) return;
  view.innerHTML = '<h2>New Spec</h2>';
  let { state, nextQuestion: q } = await fetch('/api/wizard/start', { method: 'POST' }).then((r) => r.json());
  const log = document.createElement('div');
  log.className = 'pane';
  view.appendChild(log);
  while (q !== null && q !== undefined) {
    const answer = await ask(q);
    const next = await fetch('/api/wizard/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, answer }),
    }).then((r) => r.json());
    state = next.state;
    q = next.nextQuestion;
    log.innerHTML += '<div>' + (answer.question || '') + ': <code>' + JSON.stringify(answer.value) + '</code></div>';
  }
  const compiled = await fetch('/api/wizard/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  }).then((r) => r.json());
  view.innerHTML += '<h3>Generated YAML</h3><pre>' + escapeHtml(compiled.yaml) + '</pre>';
  const create = document.createElement('button');
  create.textContent = 'Create spec';
  create.addEventListener('click', async () => {
    const r = await fetch('/api/specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: compiled.name, yaml: compiled.yaml }),
    });
    create.textContent = r.ok ? 'Created' : 'Error';
  });
  view.appendChild(create);
}

function ask(q) {
  // v0: synchronous prompts via window.prompt, mapped to the wizard
  // answer shape. studio-ui v1 will replace these with proper form UI.
  if (q.id === 'target') {
    const choices = q.choices.map((c) => c.value).join('|');
    const v = window.prompt('Target shape (' + choices + ')', 'cli') || 'cli';
    return Promise.resolve({ question: 'target', value: v });
  }
  if (q.id === 'name') {
    const v = window.prompt(q.prompt, 'my-spec') || 'my-spec';
    return Promise.resolve({ question: 'name', value: v });
  }
  if (q.id === 'model') {
    const v = window.prompt(q.prompt + ' (' + q.suggested.join(', ') + ')', q.suggested[0] || '');
    return Promise.resolve({ question: 'model', value: v });
  }
  if (q.id === 'tools') {
    const v = window.prompt(q.prompt, q.suggested.join(',')) || '';
    return Promise.resolve({ question: 'tools', value: v.split(',').map((s) => s.trim()).filter(Boolean) });
  }
  if (q.id === 'permissionMode') {
    const v = window.prompt(q.prompt + ' (default|plan|auto)', 'default') || 'default';
    return Promise.resolve({ question: 'permissionMode', value: v });
  }
}

async function renderPlugins() {
  const view = $('#view-plugins');
  if (!view) return;
  view.innerHTML = 'Loading…';
  const { plugins } = await fetch('/api/plugins').then((r) => r.json());
  if (plugins.length === 0) {
    view.innerHTML = '<p>No plugins. Drop a folder under ~/.crewhaus/plugins/ to add one.</p>';
    return;
  }
  view.innerHTML = '<h2>Plugins</h2>';
  for (const p of plugins) {
    const card = document.createElement('div');
    card.className = 'pane';
    card.innerHTML = '<strong>' + p.name + '</strong> v' + p.version + (p.description ? ' — ' + p.description : '');
    view.appendChild(card);
  }
}

function escapeHtml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

activate('specs');
`.trim();
}

/**
 * Section 31 — multi-spec dashboard renderer. Returns an HTML fragment
 * that can be embedded in any tab. Aggregates per-spec metrics; the
 * data fetching is the caller's responsibility (keeps the renderer
 * pure + testable).
 */
export type DashboardRow = {
  readonly specName: string;
  readonly costUsdMicros: number;
  readonly passRate?: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly runCount: number;
};

export function renderMultiSpecDashboard(rows: ReadonlyArray<DashboardRow>): string {
  const escapeHtml = (s: string): string =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (rows.length === 0) {
    return '<p class="dashboard-empty">No specs registered yet.</p>';
  }
  const sorted = [...rows].sort((a, b) => a.specName.localeCompare(b.specName));
  const cells = sorted
    .map((r) => {
      const cost = `$${(r.costUsdMicros / 1_000_000).toFixed(4)}`;
      const pass = r.passRate !== undefined ? `${(r.passRate * 100).toFixed(1)}%` : "—";
      const p50 = r.p50LatencyMs !== undefined ? `${r.p50LatencyMs.toFixed(0)}ms` : "—";
      const p95 = r.p95LatencyMs !== undefined ? `${r.p95LatencyMs.toFixed(0)}ms` : "—";
      return `<tr>
        <td>${escapeHtml(r.specName)}</td>
        <td>${r.runCount}</td>
        <td>${cost}</td>
        <td>${pass}</td>
        <td>${p50}</td>
        <td>${p95}</td>
      </tr>`;
    })
    .join("\n");
  return `<table class="dashboard">
  <thead>
    <tr>
      <th>Spec</th>
      <th>Runs</th>
      <th>Cost</th>
      <th>Pass-rate</th>
      <th>p50 latency</th>
      <th>p95 latency</th>
    </tr>
  </thead>
  <tbody>
${cells}
  </tbody>
</table>`;
}
