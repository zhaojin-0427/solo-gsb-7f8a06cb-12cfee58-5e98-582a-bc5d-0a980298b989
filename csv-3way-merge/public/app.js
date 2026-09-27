'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const ROLE_LABEL = { base: '基准', local: '本地', remote: '远端' };
  const STATUS_LABEL = {
    unchanged: '未变化',
    modified: '自动合并修改',
    added: '自动新增',
    deleted: '自动删除',
    conflict: '冲突',
  };
  // 账本取值来源徽标（与服务端 sourceLegend 对应的短文案）
  const SOURCE_LABEL = {
    base: '基准',
    local: '本地',
    remote: '远端',
    both: '两侧相同',
    manual: '人工填写',
  };

  const state = {
    upload: null, // /api/upload 返回（含 roundId，不含完整解析数据）
    roundId: null, // 本轮标识：合并 / 导出只传它，大文件数据留在服务端
    model: null, // /api/merge 返回的 model
    decisions: emptyDecisions(),
    filter: 'all',
    parentColumn: '', // 父子层级核验选择的父键列（空 = 未选择）
    keyCheckColumns: [], // 疑似唯一键变更核对选中的非键比较列
    keyCheckMaxDiff: 0, // 差异上限（0 至比较列数的整数）
  };

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 裁决按唯一键存取：唯一键可能是 "__proto__" / "constructor" 等与对象
  // 继承属性重名的合法字符串。容器一律用无原型对象，读取只看自有属性，
  // 否则 __proto__ 的裁决会污染原型链并串到其他行（其他行还会被误判已裁决）。
  function emptyDecisions() {
    return { rowConflicts: Object.create(null), cells: Object.create(null) };
  }

  function ownProp(obj, key) {
    return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }

  /**
   * 把服务端返回的裁决规范化为无原型容器：即使 JSON 里带 "__proto__" 键，
   * 落到页面状态后也只是普通自有属性，不触碰任何对象的原型链。
   */
  function adoptDecisions(raw) {
    const out = emptyDecisions();
    const src = raw && typeof raw === 'object' ? raw : {};
    if (src.rowConflicts && typeof src.rowConflicts === 'object') {
      for (const key of Object.keys(src.rowConflicts)) {
        const d = src.rowConflicts[key];
        if (d === 'keep' || d === 'delete') out.rowConflicts[key] = d;
      }
    }
    if (src.cells && typeof src.cells === 'object') {
      for (const key of Object.keys(src.cells)) {
        const cols = src.cells[key];
        if (!cols || typeof cols !== 'object') continue;
        const colCopy = Object.create(null);
        for (const col of Object.keys(cols)) {
          const dec = cols[col];
          if (!dec || typeof dec !== 'object') continue;
          if (dec.choice === 'local' || dec.choice === 'remote') {
            colCopy[col] = { choice: dec.choice };
          } else if (dec.choice === 'manual' && dec.value != null) {
            colCopy[col] = { choice: 'manual', value: String(dec.value) };
          }
        }
        out.cells[key] = colCopy;
      }
    }
    return out;
  }

  function showErrors(el, errors) {
    if (!errors || errors.length === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const items = errors
      .map((e) => {
        const where = [
          e.file ? ROLE_LABEL[e.file] || e.file : '',
          e.line ? `第 ${e.line} 行` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<li>${where ? `<code>${esc(where)}</code> ` : ''}${esc(e.message)}</li>`;
      })
      .join('');
    el.innerHTML = `<h3>校验未通过（${errors.length} 项），请修正后重试</h3><ul>${items}</ul>`;
    el.classList.remove('hidden');
  }

  async function postJSON(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({ ok: false, errors: [] }));
    return { status: resp.status, data };
  }

  // ---------- 第一步：上传 ----------
  const fileInputs = {
    base: $('#file-base'),
    local: $('#file-local'),
    remote: $('#file-remote'),
  };

  for (const [role, input] of Object.entries(fileInputs)) {
    input.addEventListener('change', () => {
      $(`#name-${role}`).textContent = input.files[0]
        ? `${input.files[0].name}（${formatSize(input.files[0].size)}）`
        : '未选择文件';
    });
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  $('#btn-upload').addEventListener('click', async () => {
    const fd = new FormData();
    const missing = [];
    for (const role of ['base', 'local', 'remote']) {
      const f = fileInputs[role].files[0];
      if (!f) missing.push(ROLE_LABEL[role]);
      else fd.append(role, f, f.name || `${role}.csv`);
    }
    const errEl = $('#upload-errors');
    if (missing.length) {
      showErrors(errEl, [{ file: null, line: null, message: `请选择文件：${missing.join('、')}` }]);
      return;
    }
    const btn = $('#btn-upload');
    btn.disabled = true;
    btn.textContent = '解析中…';
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!data.ok) {
        showErrors(errEl, data.errors);
        return;
      }
      errEl.classList.add('hidden');
      state.upload = data;
      state.roundId = data.roundId;
      enterKeyStep();
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `请求失败：${e.message}` }]);
    } finally {
      btn.disabled = false;
      btn.textContent = '解析文件';
    }
  });

  $('#btn-sample').addEventListener('click', async () => {
    const errEl = $('#upload-errors');
    try {
      const roles = ['base', 'local', 'remote'];
      const texts = await Promise.all(
        roles.map((r) => fetch(`/samples/${r}.csv`).then((r2) => r2.text())),
      );
      const fd = new FormData();
      roles.forEach((r, i) => fd.append(r, new File([texts[i]], `${r}.csv`, { type: 'text/csv' })));
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!data.ok) {
        showErrors(errEl, data.errors);
        return;
      }
      errEl.classList.add('hidden');
      state.upload = data;
      state.roundId = data.roundId;
      enterKeyStep();
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `示例载入失败：${e.message}` }]);
    }
  });

  // ---------- 第二步：键列 ----------
  function enterKeyStep() {
    const { headers, keyColumns, files } = state.upload;
    // 新一轮上传：收起可能残留的上一轮结果
    $('#step-result').classList.add('hidden');
    resetLedger();
    resetHierarchy();
    resetOrder();
    resetKeycheck();
    const sel = $('#key-select');
    sel.innerHTML = keyColumns.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    // 默认猜测：名为 id / key / 编号 等
    const guess =
      headers.find((h) => /^(id|key|code|编号|编码|id_?)$/i.test(h.trim())) || headers[0];
    sel.value = guess;

    $('#file-meta').innerHTML = ['base', 'local', 'remote']
      .map(
        (role) =>
          `<span class="meta-item">${ROLE_LABEL[role]}：${files[role].rowCount} 行数据 · ${headers.length} 列</span>`,
      )
      .join('');

    $('#step-key').classList.remove('hidden');
    $('#step-key').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#btn-merge').addEventListener('click', async () => {
    const keyColumn = $('#key-select').value;
    const errEl = $('#key-errors');
    const btn = $('#btn-merge');
    btn.disabled = true;
    try {
      const { status, data } = await postJSON('/api/merge', {
        roundId: state.roundId,
        keyColumn,
      });
      if (!data.ok) {
        if (status === 404 && data.stage === 'round') {
          showErrors($('#upload-errors'), data.errors);
          handleRoundExpired();
          return;
        }
        showErrors(errEl, data.errors);
        if (status === 400 && (data.stage === 'keys' || data.stage === 'headers')) return;
        return;
      }
      errEl.classList.add('hidden');
      state.roundId = data.roundId || state.roundId;
      state.model = data.model;
      state.decisions = emptyDecisions();
      enterResultStep();
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `请求失败：${e.message}` }]);
    } finally {
      btn.disabled = false;
    }
  });

  // 本轮标识失效（过期 / 服务重启）：明确提示，并收起依赖该轮数据的后续步骤
  function handleRoundExpired() {
    state.roundId = null;
    state.model = null;
    state.upload = null;
    state.decisions = emptyDecisions();
    resetLedger();
    resetHierarchy();
    resetOrder();
    resetKeycheck();
    $('#step-key').classList.add('hidden');
    $('#step-result').classList.add('hidden');
    $('#step-upload').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- 第三步：结果展示与冲突解决 ----------
  function enterResultStep() {
    $('#step-result').classList.remove('hidden');
    resetPlanReport();
    renderSummary();
    renderTable();
    setupHierarchy();
    setupKeycheck();
    updateResolutionState();
    $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSummary() {
    const s = state.model.summary;
    const items = [
      ['总行数', s.total, ''],
      ['未变化', s.unchanged, ''],
      ['自动修改', s.modified, ''],
      ['自动新增', s.added, ''],
      ['自动删除', s.deleted, ''],
    ];
    let html = items.map(([k, v]) => `<span class="stat">${k}<b>${v}</b></span>`).join('');
    html += `<span class="stat conflict">冲突行 <b>${s.conflict}</b>（行级 ${s.rowConflicts} · 单元格 ${s.cellConflicts}）</span>`;
    $('#summary').innerHTML = html;
  }

  function cellDec(rowKey, col, choice, value) {
    // 无原型容器：键为 "__proto__" 等时也是普通自有属性
    const cells = ownProp(state.decisions.cells, rowKey);
    const map = cells || (state.decisions.cells[rowKey] = Object.create(null));
    map[col] = {
      choice,
      value: value != null ? value : ownProp(map, col)?.value || '',
    };
  }

  function rowConflictType(row) {
    const rc = row.conflicts.find(
      (c) => c.type === 'row-delete-modify' || c.type === 'row-add-divergent',
    );
    return rc ? rc.type : null;
  }

  function isCellConflict(row, c) {
    return row.conflicts.some((cf) => cf.type === 'cell' && cf.column === c);
  }

  function isAddDiverge(row, c) {
    const rc = row.conflicts.find((cf) => cf.type === 'row-add-divergent');
    return rc && rc.differing.includes(c);
  }

  function renderTable() {
    const m = state.model;
    const thead = $('#merge-thead');
    const tbody = $('#merge-tbody');

    thead.innerHTML =
      `<tr><th>唯一键 <span class="key-tag">${esc(m.keyColumn)}</span></th>
       <th class="status-col">状态 / 行级处理</th>` +
      m.headers
        .map((h, i) => `<th>${esc(h)}${i === m.keyIndex ? ' 🔑' : ''}</th>`)
        .join('') +
      `</tr>`;

    tbody.innerHTML = m.rows.map((row) => renderRow(row)).join('');

    // 事件绑定（事件委托）
    tbody.onclick = (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const tr = btn.closest('tr[data-key]');
      const key = tr.dataset.key;
      const row = m.rows.find((r) => r.key === key);
      const act = btn.dataset.act;
      if (act === 'row-keep') {
        state.decisions.rowConflicts[key] = 'keep';
        renderTable();
        updateResolutionState();
      } else if (act === 'row-delete') {
        state.decisions.rowConflicts[key] = 'delete';
        renderTable();
        updateResolutionState();
      } else if (act === 'pick-local' || act === 'pick-remote') {
        cellDec(key, Number(btn.dataset.col), act === 'pick-local' ? 'local' : 'remote');
        renderTable();
        updateResolutionState();
      } else if (act === 'pick-manual') {
        const wrap = btn.closest('.resolve');
        wrap.querySelector('.manual-row').classList.add('show');
        wrap.querySelector('input').focus();
      } else if (act === 'manual-apply') {
        const input = tr.querySelector(`input[data-manual-col="${btn.dataset.col}"]`);
        cellDec(key, Number(btn.dataset.col), 'manual', input.value);
        renderTable();
        updateResolutionState();
      }
    };
    tbody.oninput = (ev) => {
      if (ev.target.dataset && ev.target.dataset.manualCol != null) {
        const key = ev.target.closest('tr[data-key]').dataset.key;
        cellDec(key, Number(ev.target.dataset.manualCol), 'manual', ev.target.value);
        updateResolutionState();
      }
    };

    applyFilter();
  }

  function renderRow(row) {
    const m = state.model;
    const rowType = rowConflictType(row);
    const rowDecision = ownProp(state.decisions.rowConflicts, row.key);
    const willDelete =
      row.status === 'deleted' || (rowType && rowDecision === 'delete');

    const cls = ['data-row'];
    if (willDelete) cls.push('row-deleted');
    if (row.status === 'conflict') cls.push('row-conflict');
    if (rowType && row.status === 'conflict' && !rowDecision) cls.push('row-unresolved');

    const lineRefs = [
      row.base ? `基准 第${row.base.line}行` : null,
      row.local ? `本地 第${row.local.line}行` : null,
      row.remote ? `远端 第${row.remote.line}行` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    let html = `<tr class="${cls.join(' ')}" data-key="${esc(row.key)}" data-status="${row.status}">
      <td class="key-cell">${esc(row.key)}<span class="line-refs">${esc(lineRefs)}</span></td>
      <td class="status-cell"><div>${STATUS_LABEL[row.status]}</div>${renderRowResolve(row, rowType, rowDecision)}</td>`;

    for (let c = 0; c < m.headers.length; c++) {
      if (c === m.keyIndex) {
        html += `<td><div class="tri"><div class="v base">${esc(row.key)}</div></div></td>`;
        continue;
      }
      html += `<td>${renderTriCell(row, c)}${renderCellResolve(row, c, rowType, rowDecision)}</td>`;
    }
    html += `</tr>`;
    return html;
  }

  function vBlock(side, row, c) {
    const sideName = { base: '基准', local: '本', remote: '远' };
    const rec = row[side];
    if (!rec) {
      return `<div class="v missing"><span class="src-tag">${sideName[side]}</span>— 整行缺失（删除/未新增）</div>`;
    }
    const val = rec.cells[c] == null ? '' : rec.cells[c];
    let mark = '';
    if (side !== 'base' && row.base) {
      const changed = side === 'local' ? row.changes.local : row.changes.remote;
      if (changed.includes(c)) mark = 'changed';
    }
    return `<div class="v ${side} ${mark}"><span class="src-tag">${sideName[side]}</span>${
      val === '' ? '<span style="color:#bbb">（空）</span>' : esc(val)
    }</div>`;
  }

  function renderTriCell(row, c) {
    const isAuto = row.autoCells.includes(c);
    const conflict = isCellConflict(row, c) || isAddDiverge(row, c);
    const cls = ['tri'];
    if (isAuto) cls.push('cell-auto');
    if (conflict) cls.push('cell-conflict');
    return `<div class="${cls.join(' ')}">
      ${vBlock('base', row, c)}
      ${vBlock('local', row, c)}
      ${vBlock('remote', row, c)}
    </div>`;
  }

  function renderRowResolve(row, rowType, decision) {
    if (row.status !== 'conflict') return '';
    const d = ownProp(state.decisions.cells, row.key) || Object.create(null);

    if (rowType === 'row-delete-modify') {
      const cf = row.conflicts.find((c) => c.type === 'row-delete-modify');
      const delName = cf.deleter === 'local' ? '本地' : '远端';
      const modName = cf.modifier === 'local' ? '本地' : '远端';
      return `<div class="resolve row-resolve">
        <div class="resolve-title">${delName}删除 vs ${modName}修改</div>
        <div class="choice-row">
          <button data-act="row-keep" class="choice-btn ${decision === 'keep' ? 'picked' : ''}">保留行（采纳修改）</button>
          <button data-act="row-delete" class="choice-btn ${decision === 'delete' ? 'picked' : ''}">删除行</button>
        </div>
      </div>`;
    }
    if (rowType === 'row-add-divergent') {
      return `<div class="resolve row-resolve">
        <div class="resolve-title">本地与远端都新增此键，但内容不同</div>
        <div class="choice-row">
          <button data-act="row-keep" class="choice-btn ${decision === 'keep' ? 'picked' : ''}">保留并逐格合并</button>
          <button data-act="row-delete" class="choice-btn ${decision === 'delete' ? 'picked' : ''}">不加入（删除）</button>
        </div>
      </div>`;
    }
    return '';
  }

  function renderCellResolve(row, c, rowType, rowDecision) {
    const cellConflict = isCellConflict(row, c);
    const addDiverge = isAddDiverge(row, c);
    if (!cellConflict && !addDiverge) return '';

    // 行级冲突尚未决定保留 / 决定删除时，不显示单元格选择
    if (rowType && rowDecision !== 'keep') return '';

    const dec = ownProp(ownProp(state.decisions.cells, row.key), c);
    const picked = dec ? dec.choice : null;
    const manualVal = dec && dec.value != null ? dec.value : '';

    return `<div class="resolve">
      <div class="resolve-title">${cellConflict ? '同一格双方改成不同值' : '两侧新增值不同'}：</div>
      <div class="choice-row">
        <button data-act="pick-local" data-col="${c}"
          class="choice-btn pick-local ${picked === 'local' ? 'picked' : ''}">取本地</button>
        <button data-act="pick-remote" data-col="${c}"
          class="choice-btn pick-remote ${picked === 'remote' ? 'picked' : ''}">取远端</button>
        <button data-act="pick-manual" data-col="${c}"
          class="choice-btn ${picked === 'manual' ? 'picked' : ''}">手填…</button>
      </div>
      <div class="manual-row ${picked === 'manual' ? 'show' : ''}">
        <input type="text" data-manual-col="${c}" value="${esc(manualVal)}" placeholder="输入自定义值" />
        <button data-act="manual-apply" data-col="${c}">确定</button>
      </div>
    </div>`;
  }

  // ---------- 过滤 ----------
  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button.filter');
    if (!btn) return;
    document.querySelectorAll('#filters .filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    applyFilter();
  });

  function applyFilter() {
    document.querySelectorAll('#merge-tbody tr.data-row').forEach((tr) => {
      const show = state.filter === 'all' || tr.dataset.status === state.filter;
      tr.classList.toggle('hidden', !show);
    });
  }

  // ---------- 未解决统计 ----------
  function computeUnresolved() {
    const m = state.model;
    if (!m) return { count: 0, total: 0 };
    let unresolved = 0;
    let total = 0;
    for (const row of m.rows) {
      if (row.status !== 'conflict') continue;
      const type = rowConflictType(row);
      const rowDecision = ownProp(state.decisions.rowConflicts, row.key);
      if (type) {
        total++;
        if (!rowDecision) {
          unresolved++;
          continue;
        }
        if (rowDecision === 'delete') continue;
        // 保留：新增分歧行的每格都要解决
        if (type === 'row-add-divergent') {
          const rc = row.conflicts.find((c) => c.type === 'row-add-divergent');
          for (const c of rc.differing) {
            total++;
            if (!cellResolved(row.key, c)) unresolved++;
          }
        }
      }
      for (const cf of row.conflicts) {
        if (cf.type !== 'cell') continue;
        total++;
        if (!cellResolved(row.key, cf.column)) unresolved++;
      }
    }
    return { count: unresolved, total };
  }

  function cellResolved(key, c) {
    const d = ownProp(ownProp(state.decisions.cells, key), c);
    if (!d) return false;
    if (d.choice === 'manual') return d.value !== '';
    return d.choice === 'local' || d.choice === 'remote';
  }

  function updateResolutionState() {
    const { count, total } = computeUnresolved();
    const badge = $('#unresolved-badge');
    const btn = $('#btn-export');
    // 方案导出与 CSV 导出同条件：冲突全部裁决，且本轮确实存在冲突行
    $('#btn-plan-export').disabled = count > 0 || !hasConflictRows();
    if (count > 0) {
      badge.textContent = `还有 ${count} / ${total} 处冲突未解决`;
      badge.className = 'badge unresolved';
      btn.disabled = true;
      btn.title = '请先解决全部冲突';
    } else {
      badge.textContent = total === 0 ? '无冲突，可直接导出' : `全部 ${total} 处冲突已解决 ✓`;
      badge.className = 'badge resolved';
      btn.disabled = false;
      btn.title = '';
    }
    // 裁决每次变动后联动刷新来源账本（有未决冲突时账本不生成）
    refreshLedger(count);
    // 同样联动父子层级核验（未选父键列时只提示选择）
    refreshHierarchy(count);
    // 以及父子数据导入顺序（沿用层级区域的父键列选择）
    refreshOrder(count);
    // 以及疑似唯一键变更核对（未选比较列时只提示选择）
    refreshKeycheck(count);
  }

  // ---------- 来源账本 ----------
  // 账本完全由服务端按本轮模型与当前裁决计算，前端只负责展示与下载
  let ledgerTimer = null; // 手填防抖
  let ledgerSeq = 0; // 丢弃过期的响应

  function resetLedger() {
    clearTimeout(ledgerTimer);
    ledgerSeq++;
    $('#step-ledger').classList.add('hidden');
    $('#ledger-content').classList.add('hidden');
    $('#ledger-pending').classList.add('hidden');
    $('#ledger-errors').classList.add('hidden');
    $('#ledger-tbody').innerHTML = '';
    $('#ledger-deleted-tbody').innerHTML = '';
    $('#btn-ledger').disabled = true;
  }

  /**
   * 裁决变化后调用：全部解决才向服务端请求账本（防抖），
   * 有未决冲突时收起账本内容，避免展示过时结果。
   */
  function refreshLedger(unresolvedCount) {
    if (!state.model) {
      resetLedger();
      return;
    }
    $('#step-ledger').classList.remove('hidden');
    const btn = $('#btn-ledger');
    if (unresolvedCount > 0) {
      clearTimeout(ledgerTimer);
      ledgerSeq++;
      $('#ledger-content').classList.add('hidden');
      $('#ledger-errors').classList.add('hidden');
      $('#ledger-pending').classList.remove('hidden');
      btn.disabled = true;
      return;
    }
    $('#ledger-pending').classList.add('hidden');
    clearTimeout(ledgerTimer);
    ledgerTimer = setTimeout(loadLedger, 250);
  }

  async function requestLedger() {
    const { status, data } = await postJSON('/api/ledger', {
      roundId: state.roundId,
      decisions: state.decisions,
    });
    if (data.ok) return data.ledger;
    if (status === 404 && data.stage === 'round') {
      showErrors($('#upload-errors'), data.errors || []);
      handleRoundExpired();
      return null;
    }
    if (status === 409) {
      // 服务端判定仍有未决冲突：拒绝生成完整账本，回到待解决提示
      $('#ledger-content').classList.add('hidden');
      $('#ledger-pending').classList.remove('hidden');
      $('#btn-ledger').disabled = true;
      return null;
    }
    showErrors(
      $('#ledger-errors'),
      data.errors || [{ file: null, line: null, message: '账本生成失败' }],
    );
    return null;
  }

  async function loadLedger() {
    const seq = ++ledgerSeq;
    const ledger = await requestLedger();
    if (!ledger || seq !== ledgerSeq) return;
    $('#ledger-errors').classList.add('hidden');
    renderLedger(ledger);
    $('#ledger-content').classList.remove('hidden');
    $('#btn-ledger').disabled = false;
  }

  function ledgerLinesText(lines) {
    if (!lines) return '';
    return ['base', 'local', 'remote']
      .filter((s) => lines[s] != null)
      .map((s) => `${ROLE_LABEL[s]} 第${lines[s]}行`)
      .join(' · ');
  }

  function renderLedger(ledger) {
    // 来源图例
    $('#ledger-legend').innerHTML = Object.entries(SOURCE_LABEL)
      .map(([code, label]) => `<span class="lg-chip src-${code}">${label}</span>`)
      .join('');

    $('#ledger-summary').innerHTML =
      `<span class="stat">保留键 <b>${ledger.rowCount}</b></span>` +
      `<span class="stat">删除键 <b>${ledger.deletedCount}</b></span>`;

    $('#ledger-thead').innerHTML =
      `<tr><th>唯一键 <span class="key-tag">${esc(ledger.keyColumn)}</span></th>` +
      ledger.headers
        .map((h) => `<th>${esc(h)}</th>`)
        .join('') +
      `</tr>`;

    $('#ledger-tbody').innerHTML = ledger.rows
      .map((row) => {
        const tds = row.cells
          .map((cell) => {
            const lines = ledgerLinesText(cell.lines);
            const val =
              cell.value === '' ? '<span class="lg-empty">（空）</span>' : esc(cell.value);
            return `<td><div class="lg-val">${val}</div>` +
              `<div class="lg-src src-${cell.source}">${esc(
                SOURCE_LABEL[cell.source] || cell.source,
              )}${lines ? ` · ${esc(lines)}` : ''}</div></td>`;
          })
          .join('');
        return `<tr><td class="key-cell">${esc(row.key)}</td>${tds}</tr>`;
      })
      .join('');

    // 删除键单独列出，不混入输出行
    const delBody = $('#ledger-deleted-tbody');
    delBody.innerHTML = ledger.deleted
      .map(
        (d) =>
          `<tr><td class="key-cell">${esc(d.key)}</td>` +
          `<td>${esc(d.reasonText)}</td>` +
          `<td>${esc(ledgerLinesText(d.lines) || '—')}</td></tr>`,
      )
      .join('');
    $('#ledger-deleted-empty').classList.toggle('hidden', ledger.deleted.length > 0);
    $('#ledger-deleted-wrap').classList.toggle('hidden', ledger.deleted.length === 0);
  }

  // 下载 JSON 账本：以服务端按当前裁决实时计算的结果为准
  $('#btn-ledger').addEventListener('click', async () => {
    const errEl = $('#ledger-errors');
    const btn = $('#btn-ledger');
    btn.disabled = true;
    try {
      const ledger = await requestLedger();
      if (!ledger) return;
      errEl.classList.add('hidden');
      const blob = new Blob([JSON.stringify(ledger, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merge-ledger.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `账本下载失败：${e.message}` }]);
    } finally {
      // 409（仍有未决冲突）时保持禁用，其余情况恢复
      btn.disabled = $('#ledger-content').classList.contains('hidden');
    }
  });

  // ---------- 父子层级核验 ----------
  // 核验完全由服务端按本轮模型与当前裁决计算，只提示问题，不影响 CSV 导出
  let hierTimer = null; // 防抖
  let hierSeq = 0; // 丢弃过期的响应

  function resetHierarchy() {
    clearTimeout(hierTimer);
    hierSeq++;
    state.parentColumn = '';
    $('#step-hierarchy').classList.add('hidden');
    $('#hierarchy-content').classList.add('hidden');
    $('#hierarchy-pending').classList.add('hidden');
    $('#hierarchy-errors').classList.add('hidden');
    $('#hierarchy-hint').classList.add('hidden');
    $('#hierarchy-tbody').innerHTML = '';
    $('#btn-hierarchy').disabled = true;
  }

  // 每次合并成功后重建父键列下拉框：候选为唯一键列之外的表头列
  function setupHierarchy() {
    const m = state.model;
    clearTimeout(hierTimer);
    hierSeq++;
    state.parentColumn = '';
    const sel = $('#parent-select');
    sel.innerHTML =
      `<option value="">（请选择父键列）</option>` +
      m.headers
        .filter((h) => h !== m.keyColumn)
        .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
        .join('');
    $('#hierarchy-content').classList.add('hidden');
    $('#hierarchy-pending').classList.add('hidden');
    $('#hierarchy-errors').classList.add('hidden');
    $('#hierarchy-tbody').innerHTML = '';
    $('#btn-hierarchy').disabled = true;
  }

  /**
   * 裁决或父键列变化后调用：全部解决且已选父键列才向服务端请求核验（防抖），
   * 有未决冲突时收起结果，避免展示过时结论。
   */
  function refreshHierarchy(unresolvedCount) {
    if (!state.model) {
      resetHierarchy();
      return;
    }
    $('#step-hierarchy').classList.remove('hidden');
    const btn = $('#btn-hierarchy');
    if (!state.parentColumn) {
      clearTimeout(hierTimer);
      hierSeq++;
      $('#hierarchy-content').classList.add('hidden');
      $('#hierarchy-pending').classList.add('hidden');
      $('#hierarchy-errors').classList.add('hidden');
      $('#hierarchy-hint').classList.remove('hidden');
      btn.disabled = true;
      return;
    }
    $('#hierarchy-hint').classList.add('hidden');
    if (unresolvedCount > 0) {
      clearTimeout(hierTimer);
      hierSeq++;
      $('#hierarchy-content').classList.add('hidden');
      $('#hierarchy-errors').classList.add('hidden');
      $('#hierarchy-pending').classList.remove('hidden');
      btn.disabled = true;
      return;
    }
    $('#hierarchy-pending').classList.add('hidden');
    clearTimeout(hierTimer);
    hierTimer = setTimeout(loadHierarchy, 250);
  }

  $('#parent-select').addEventListener('change', () => {
    state.parentColumn = $('#parent-select').value;
    const { count } = computeUnresolved();
    refreshHierarchy(count);
    // 父键列变化后导入顺序同样重新计算
    refreshOrder(count);
  });

  async function requestHierarchy() {
    const { status, data } = await postJSON('/api/hierarchy', {
      roundId: state.roundId,
      decisions: state.decisions,
      parentColumn: state.parentColumn,
    });
    if (data.ok) return data.check;
    if (status === 404 && data.stage === 'round') {
      showErrors($('#upload-errors'), data.errors || []);
      handleRoundExpired();
      return null;
    }
    if (status === 409) {
      // 服务端判定仍有未决冲突：不给出完整结论，回到待解决提示
      $('#hierarchy-content').classList.add('hidden');
      $('#hierarchy-pending').classList.remove('hidden');
      $('#btn-hierarchy').disabled = true;
      return null;
    }
    showErrors(
      $('#hierarchy-errors'),
      data.errors || [{ file: null, line: null, message: '层级核验失败' }],
    );
    return null;
  }

  async function loadHierarchy() {
    const seq = ++hierSeq;
    const check = await requestHierarchy();
    if (!check || seq !== hierSeq) return;
    $('#hierarchy-errors').classList.add('hidden');
    renderHierarchy(check);
    $('#hierarchy-content').classList.remove('hidden');
    $('#btn-hierarchy').disabled = false;
  }

  function renderHierarchy(check) {
    $('#hierarchy-summary').innerHTML =
      `<span class="stat">父键列 <b>${esc(check.parentColumn)}</b></span>` +
      `<span class="stat">核验行数 <b>${check.rowCount}</b></span>` +
      `<span class="stat ${check.issueCount > 0 ? 'conflict' : ''}">问题 <b>${check.issueCount}</b></span>`;

    $('#hierarchy-tbody').innerHTML = check.issues
      .map(
        (it) =>
          `<tr><td class="key-cell">${esc(it.key)}</td>` +
          `<td>${esc(it.parentKey)}</td>` +
          `<td><span class="hier-type hier-${it.type}">${esc(it.typeText)}</span></td>` +
          `<td>第 ${it.line} 行</td></tr>`,
      )
      .join('');
    $('#hierarchy-clean').classList.toggle('hidden', check.issueCount > 0);
    $('#hierarchy-wrap').classList.toggle('hidden', check.issueCount === 0);
  }

  // 下载核验 JSON：以服务端按当前裁决实时计算的结果为准
  $('#btn-hierarchy').addEventListener('click', async () => {
    const errEl = $('#hierarchy-errors');
    const btn = $('#btn-hierarchy');
    btn.disabled = true;
    try {
      const check = await requestHierarchy();
      if (!check) return;
      errEl.classList.add('hidden');
      const blob = new Blob([JSON.stringify(check, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'hierarchy-check.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `核验结果下载失败：${e.message}` }]);
    } finally {
      // 409（仍有未决冲突）时保持禁用，其余情况恢复
      btn.disabled = $('#hierarchy-content').classList.contains('hidden');
    }
  });

  // ---------- 父子数据导入顺序 ----------
  // 顺序完全由服务端按本轮模型与当前裁决计算：存在缺失父项 / 循环时列出问题并
  // 阻止顺序导出（合并 CSV 导出不受影响）；层级有效时展示父先子后的键序，
  // 可下载沿用基准表头与原单元格值的顺序 CSV
  let orderTimer = null; // 防抖
  let orderSeq = 0; // 丢弃过期的响应

  function resetOrder() {
    clearTimeout(orderTimer);
    orderSeq++;
    $('#step-order').classList.add('hidden');
    $('#order-result').classList.add('hidden');
    $('#order-pending').classList.add('hidden');
    $('#order-errors').classList.add('hidden');
    $('#order-hint').classList.add('hidden');
    $('#order-issues-tbody').innerHTML = '';
    $('#order-keys-tbody').innerHTML = '';
    $('#btn-order').disabled = true;
  }

  /**
   * 裁决或父键列变化后调用：全部解决且已选父键列才向服务端请求顺序（防抖），
   * 有未决冲突或未选父键列时收起结果，避免展示过时结论。
   */
  function refreshOrder(unresolvedCount) {
    if (!state.model) {
      resetOrder();
      return;
    }
    $('#step-order').classList.remove('hidden');
    $('#order-parent-now').textContent = state.parentColumn
      ? `父键列沿用第 5 区的选择：${state.parentColumn}`
      : '父键列沿用第 5 区的选择（尚未选择）。';
    const btn = $('#btn-order');
    if (!state.parentColumn) {
      clearTimeout(orderTimer);
      orderSeq++;
      $('#order-result').classList.add('hidden');
      $('#order-pending').classList.add('hidden');
      $('#order-errors').classList.add('hidden');
      $('#order-hint').classList.remove('hidden');
      btn.disabled = true;
      return;
    }
    $('#order-hint').classList.add('hidden');
    if (unresolvedCount > 0) {
      clearTimeout(orderTimer);
      orderSeq++;
      $('#order-result').classList.add('hidden');
      $('#order-errors').classList.add('hidden');
      $('#order-pending').classList.remove('hidden');
      btn.disabled = true;
      return;
    }
    $('#order-pending').classList.add('hidden');
    clearTimeout(orderTimer);
    orderTimer = setTimeout(loadOrder, 250);
  }

  async function requestOrder() {
    const { status, data } = await postJSON('/api/order', {
      roundId: state.roundId,
      decisions: state.decisions,
      parentColumn: state.parentColumn,
    });
    if (data.ok) return data.order;
    if (status === 404 && data.stage === 'round') {
      showErrors($('#upload-errors'), data.errors || []);
      handleRoundExpired();
      return null;
    }
    if (status === 409) {
      // 服务端判定仍有未决冲突：不给出顺序，回到待解决提示
      $('#order-result').classList.add('hidden');
      $('#order-pending').classList.remove('hidden');
      $('#btn-order').disabled = true;
      return null;
    }
    showErrors(
      $('#order-errors'),
      data.errors || [{ file: null, line: null, message: '导入顺序计算失败' }],
    );
    return null;
  }

  async function loadOrder() {
    const seq = ++orderSeq;
    const order = await requestOrder();
    if (!order || seq !== orderSeq) return;
    $('#order-errors').classList.add('hidden');
    renderOrder(order);
    $('#order-result').classList.remove('hidden');
    // 存在缺失父项 / 循环时阻止顺序导出
    $('#btn-order').disabled = !order.valid;
  }

  function renderOrder(order) {
    $('#order-summary').innerHTML =
      `<span class="stat">父键列 <b>${esc(order.parentColumn)}</b></span>` +
      `<span class="stat">行数 <b>${order.rowCount}</b></span>` +
      `<span class="stat ${order.issueCount > 0 ? 'conflict' : ''}">问题 <b>${order.issueCount}</b></span>`;

    $('#order-blocked').classList.toggle('hidden', order.valid);
    $('#order-issues-wrap').classList.toggle('hidden', order.valid);
    $('#order-keys-wrap').classList.toggle('hidden', !order.valid);

    if (!order.valid) {
      // 列出问题键与类型（按最终 CSV 行序）
      $('#order-issues-tbody').innerHTML = order.issues
        .map(
          (it) =>
            `<tr><td class="key-cell">${esc(it.key)}</td>` +
            `<td>${esc(it.parentKey)}</td>` +
            `<td><span class="hier-type hier-${it.type}">${esc(it.typeText)}</span></td>` +
            `<td>第 ${it.line} 行</td></tr>`,
        )
        .join('');
      return;
    }
    // 排序后的键序（父先子后）
    $('#order-keys-tbody').innerHTML = order.keys
      .map(
        (k, i) =>
          `<tr><td class="order-seq">${i + 1}</td>` +
          `<td class="key-cell">${esc(k.key)}</td>` +
          `<td>${k.parentKey === '' ? '<span class="lg-empty">（根）</span>' : esc(k.parentKey)}</td>` +
          `<td>第 ${k.mergedLine} 行</td></tr>`,
      )
      .join('');
  }

  // 下载顺序 CSV：服务端按当前裁决实时重算；存在问题时 409 拒绝并列出问题
  $('#btn-order').addEventListener('click', async () => {
    const errEl = $('#order-errors');
    const btn = $('#btn-order');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/order/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roundId: state.roundId,
          decisions: state.decisions,
          parentColumn: state.parentColumn,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ errors: [] }));
        if (resp.status === 404 && data.stage === 'round') {
          showErrors($('#upload-errors'), data.errors || []);
          handleRoundExpired();
          return;
        }
        if (resp.status === 409 && data.stage === 'unresolved') {
          // 服务端判定仍有未决冲突：回到待解决提示
          $('#order-result').classList.add('hidden');
          $('#order-pending').classList.remove('hidden');
          return;
        }
        // 409（缺失父项 / 循环）等：列出服务端返回的问题，并刷新展示最新结论
        showErrors(errEl, data.errors || [{ file: null, line: null, message: '顺序导出被拒绝' }]);
        if (resp.status === 409) await loadOrder();
        return;
      }
      errEl.classList.add('hidden');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'import-order.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `顺序导出失败：${e.message}` }]);
    } finally {
      // 仅当当前展示的仍是有效键序时才恢复可用
      btn.disabled =
        $('#order-result').classList.contains('hidden') ||
        $('#order-keys-wrap').classList.contains('hidden');
    }
  });

  // ---------- 疑似唯一键变更核对 ----------
  // 核对完全由服务端按本轮模型与当前裁决计算（只读，不改变任何数据与裁决）；
  // 前端只负责选择比较列 / 差异上限、展示结论与下载 JSON
  let keycheckTimer = null; // 防抖
  let keycheckSeq = 0; // 丢弃过期的响应

  function resetKeycheck() {
    clearTimeout(keycheckTimer);
    keycheckSeq++;
    state.keyCheckColumns = [];
    state.keyCheckMaxDiff = 0;
    $('#step-keycheck').classList.add('hidden');
    $('#keycheck-content').classList.add('hidden');
    $('#keycheck-pending').classList.add('hidden');
    $('#keycheck-errors').classList.add('hidden');
    $('#keycheck-hint').classList.add('hidden');
    $('#keycheck-limit').classList.add('hidden');
    $('#keycheck-tbody').innerHTML = '';
    $('#keycheck-newkeys').innerHTML = '';
    $('#btn-keycheck').disabled = true;
  }

  // 每次合并成功后重建核对参数：比较列为唯一键列之外的表头列（默认全选），
  // 差异上限默认 0；旧结论一并清除
  function setupKeycheck() {
    const m = state.model;
    clearTimeout(keycheckTimer);
    keycheckSeq++;
    state.keyCheckColumns = m.headers.filter((h) => h !== m.keyColumn);
    state.keyCheckMaxDiff = 0;
    $('#keycheck-cols').innerHTML =
      `<span class="kc-cols-label">比较列（至少一个）：</span>` +
      m.headers
        .filter((h) => h !== m.keyColumn)
        .map(
          (h) =>
            `<label class="keycheck-col"><input type="checkbox" value="${esc(h)}" checked /> ${esc(h)}</label>`,
        )
        .join('');
    const maxdiff = $('#keycheck-maxdiff');
    maxdiff.max = String(state.keyCheckColumns.length);
    maxdiff.value = '0';
    $('#keycheck-maxdiff-hint').textContent = `0 至 ${state.keyCheckColumns.length} 的整数`;
    $('#keycheck-content').classList.add('hidden');
    $('#keycheck-pending').classList.add('hidden');
    $('#keycheck-errors').classList.add('hidden');
    $('#keycheck-hint').classList.add('hidden');
    $('#keycheck-limit').classList.add('hidden');
    $('#keycheck-tbody').innerHTML = '';
    $('#keycheck-newkeys').innerHTML = '';
    $('#btn-keycheck').disabled = true;
  }

  function hideKeycheckResult() {
    $('#keycheck-content').classList.add('hidden');
    $('#keycheck-errors').classList.add('hidden');
    $('#keycheck-limit').classList.add('hidden');
    $('#btn-keycheck').disabled = true;
  }

  /**
   * 裁决或核对参数变化后调用：全部解决且至少选一个比较列才向服务端请求核对
   * （防抖）；有未决冲突或未选比较列时收起旧结论，避免展示过时结果。
   */
  function refreshKeycheck(unresolvedCount) {
    if (!state.model) {
      resetKeycheck();
      return;
    }
    $('#step-keycheck').classList.remove('hidden');
    if (state.keyCheckColumns.length === 0) {
      clearTimeout(keycheckTimer);
      keycheckSeq++;
      hideKeycheckResult();
      $('#keycheck-pending').classList.add('hidden');
      $('#keycheck-hint').classList.remove('hidden');
      return;
    }
    $('#keycheck-hint').classList.add('hidden');
    if (unresolvedCount > 0) {
      clearTimeout(keycheckTimer);
      keycheckSeq++;
      hideKeycheckResult();
      $('#keycheck-pending').classList.remove('hidden');
      return;
    }
    $('#keycheck-pending').classList.add('hidden');
    clearTimeout(keycheckTimer);
    keycheckTimer = setTimeout(loadKeycheck, 250);
  }

  // 比较列勾选变化：重算选中列，钳制差异上限，随后自动重算
  $('#keycheck-cols').addEventListener('change', () => {
    state.keyCheckColumns = Array.from(
      document.querySelectorAll('#keycheck-cols input[type="checkbox"]:checked'),
    ).map((cb) => cb.value);
    const maxdiff = $('#keycheck-maxdiff');
    maxdiff.max = String(state.keyCheckColumns.length);
    if (state.keyCheckMaxDiff > state.keyCheckColumns.length) {
      state.keyCheckMaxDiff = state.keyCheckColumns.length;
      maxdiff.value = String(state.keyCheckMaxDiff);
    }
    $('#keycheck-maxdiff-hint').textContent = `0 至 ${state.keyCheckColumns.length} 的整数`;
    refreshKeycheck(computeUnresolved().count);
  });

  // 差异上限变化：钳制到 0 至比较列数的整数后自动重算
  $('#keycheck-maxdiff').addEventListener('input', () => {
    const max = state.keyCheckColumns.length;
    let v = Number($('#keycheck-maxdiff').value);
    if (!Number.isInteger(v)) v = Math.floor(v);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v > max) v = max;
    state.keyCheckMaxDiff = v;
    // 输入被钳制时回写，避免页面显示与实际参数不一致
    if (String(v) !== $('#keycheck-maxdiff').value && $('#keycheck-maxdiff').value !== '') {
      $('#keycheck-maxdiff').value = String(v);
    }
    refreshKeycheck(computeUnresolved().count);
  });

  async function requestKeycheck() {
    const { status, data } = await postJSON('/api/keycheck', {
      roundId: state.roundId,
      decisions: state.decisions,
      columns: state.keyCheckColumns,
      maxDiff: state.keyCheckMaxDiff,
    });
    if (data.ok) return data.check;
    if (status === 404 && data.stage === 'round') {
      showErrors($('#upload-errors'), data.errors || []);
      handleRoundExpired();
      return null;
    }
    if (status === 409 && data.stage === 'unresolved') {
      // 服务端判定仍有未决冲突：不给出结论，回到待解决提示
      hideKeycheckResult();
      $('#keycheck-pending').classList.remove('hidden');
      return null;
    }
    if (status === 409 && data.stage === 'limit') {
      // 任一组超过 12 个：明确提示，不给出配对
      hideKeycheckResult();
      const limitEl = $('#keycheck-limit');
      limitEl.textContent =
        (data.errors && data.errors[0] && data.errors[0].message) ||
        `消失键或新增键超过每组 ${data.limit || 12} 个的上限，无法进行核对`;
      limitEl.classList.remove('hidden');
      return null;
    }
    hideKeycheckResult();
    showErrors(
      $('#keycheck-errors'),
      data.errors || [{ file: null, line: null, message: '疑似唯一键变更核对失败' }],
    );
    return null;
  }

  async function loadKeycheck() {
    const seq = ++keycheckSeq;
    const check = await requestKeycheck();
    if (!check || seq !== keycheckSeq) return;
    $('#keycheck-errors').classList.add('hidden');
    $('#keycheck-limit').classList.add('hidden');
    renderKeycheck(check);
    $('#keycheck-content').classList.remove('hidden');
    $('#btn-keycheck').disabled = false;
  }

  function renderKeycheck(check) {
    $('#keycheck-summary').innerHTML =
      `<span class="stat">消失键 <b>${check.oldCount}</b></span>` +
      `<span class="stat">新增键 <b>${check.newCount}</b></span>` +
      `<span class="stat">最优配对数 <b>${check.pairCount}</b></span>` +
      `<span class="stat">总代价 <b>${check.totalCost}</b></span>` +
      `<span class="stat">稳定候选 <b>${check.candidateCount}</b></span>` +
      `<span class="stat">候选代价 <b>${check.candidateCost}</b></span>`;

    // 任一组为空：空配对，未配对旧键已全部列出
    const emptyEl = $('#keycheck-empty');
    if (check.oldCount === 0 || check.newCount === 0) {
      emptyEl.textContent =
        check.oldCount === 0
          ? '消失键为空：没有可配对的旧键，返回空配对。'
          : '新增键为空：返回空配对，全部消失键均为未配对旧键。';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }
    $('#keycheck-candidate-note').classList.toggle('hidden', check.candidateCount === 0);

    $('#keycheck-tbody').innerHTML = check.oldKeys
      .map((k) => {
        const cands =
          k.possibleNewKeys.length === 0
            ? '<span class="kc-none">（无）</span>'
            : k.possibleNewKeys
                .map((p) => `<span class="kc-cand">${esc(p.newKey)}（代价 ${p.cost}）</span>`)
                .join('');
        let verdict;
        if (k.stable) {
          verdict = `<span class="kc-stable">稳定候选 → ${esc(k.stableNewKey)}（代价 ${k.stableCost}）</span>`;
        } else if (k.possibleNewKeys.length === 0) {
          verdict = '<span class="kc-none">未配对（所有最优方案都不配对）</span>';
        } else {
          verdict =
            `<span class="kc-maybe">不确定（${k.possibleNewKeys.length} 种可能` +
            `${k.canBeUnpaired ? '，也可能未配对' : ''}）</span>`;
        }
        return (
          `<tr><td class="key-cell">${esc(k.key)}</td>` +
          `<td>第 ${k.line} 行</td>` +
          `<td>${cands}</td>` +
          `<td>${k.canBeUnpaired ? '是' : '否'}</td>` +
          `<td>${verdict}</td></tr>`
        );
      })
      .join('');

    $('#keycheck-newkeys').innerHTML =
      check.unpairedNewKeys.length === 0
        ? '<span class="kc-empty">（无）</span>'
        : check.unpairedNewKeys.map((k) => `<span class="kc-tag">${esc(k)}</span>`).join('');
  }

  // 下载核对 JSON：以服务端按当前裁决与核对参数实时计算的结果为准
  $('#btn-keycheck').addEventListener('click', async () => {
    const errEl = $('#keycheck-errors');
    const btn = $('#btn-keycheck');
    btn.disabled = true;
    try {
      const check = await requestKeycheck();
      if (!check) return;
      errEl.classList.add('hidden');
      const blob = new Blob([JSON.stringify(check, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'key-change-check.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `核对结果下载失败：${e.message}` }]);
    } finally {
      // 409（未决冲突 / 超限）时保持禁用，其余情况恢复
      btn.disabled = $('#keycheck-content').classList.contains('hidden');
    }
  });

  // ---------- 跨轮裁决方案 ----------
  // 方案的生成 / 核对 / 套用全部在服务端完成：前端只负责下载、选择文件与展示报告
  const CHOICE_LABEL = { local: '取本地', remote: '取远端', manual: '手填' };
  const ROW_DECISION_LABEL = { keep: '保留行', delete: '删除行' };

  function resetPlanReport() {
    $('#plan-report').classList.add('hidden');
    $('#plan-errors').classList.add('hidden');
    $('#plan-applied-tbody').innerHTML = '';
    $('#plan-skipped-tbody').innerHTML = '';
  }

  function renderPlanReport(report) {
    $('#plan-report-summary').innerHTML =
      `<span class="stat">方案记录 <b>${report.total}</b></span>` +
      `<span class="stat">已套用 <b>${report.appliedCount}</b></span>` +
      `<span class="stat ${report.skippedCount > 0 ? 'conflict' : ''}">跳过 <b>${report.skippedCount}</b></span>`;

    $('#plan-applied-tbody').innerHTML = report.applied
      .map((r) => {
        const parts = [];
        if (r.row) parts.push(ROW_DECISION_LABEL[r.row] || r.row);
        for (const c of r.cells) {
          parts.push(
            c.choice === 'manual'
              ? `<code>${esc(c.column)}</code> 手填：${c.value === '' ? '（空）' : esc(c.value)}`
              : `<code>${esc(c.column)}</code> ${CHOICE_LABEL[c.choice] || c.choice}`,
          );
        }
        return `<tr><td class="key-cell">${esc(r.key)}</td><td>${parts.join('；')}</td></tr>`;
      })
      .join('');
    $('#plan-applied-empty').classList.toggle('hidden', report.applied.length > 0);
    $('#plan-applied-wrap').classList.toggle('hidden', report.applied.length === 0);

    $('#plan-skipped-tbody').innerHTML = report.skipped
      .map((r) => `<tr><td class="key-cell">${esc(r.key)}</td><td>${esc(r.reasonText)}</td></tr>`)
      .join('');
    $('#plan-skipped-empty').classList.toggle('hidden', report.skipped.length > 0);
    $('#plan-skipped-wrap').classList.toggle('hidden', report.skipped.length === 0);

    $('#plan-report').classList.remove('hidden');
  }

  // 下载裁决方案：服务端确认全部冲突已裁决后生成，含原值 / 冲突类型 / 裁决，不含 roundId
  $('#btn-plan-export').addEventListener('click', async () => {
    const errEl = $('#plan-errors');
    const btn = $('#btn-plan-export');
    btn.disabled = true;
    try {
      const { status, data } = await postJSON('/api/plan/export', {
        roundId: state.roundId,
        decisions: state.decisions,
      });
      if (status === 404 && data.stage === 'round') {
        showErrors($('#upload-errors'), data.errors || []);
        handleRoundExpired();
        return;
      }
      if (!data.ok) {
        showErrors(errEl, data.errors || [{ file: null, line: null, message: '方案生成失败' }]);
        return;
      }
      errEl.classList.add('hidden');
      const blob = new Blob([JSON.stringify(data.plan, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'conflict-plan.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `方案下载失败：${e.message}` }]);
    } finally {
      btn.disabled = computeUnresolved().count > 0 || !hasConflictRows();
    }
  });

  function hasConflictRows() {
    return !!state.model && state.model.rows.some((r) => r.status === 'conflict');
  }

  // 导入裁决方案：文件在浏览器中解析成 JSON 后交给服务端核对套用
  $('#btn-plan-import').addEventListener('click', () => $('#plan-file').click());

  $('#plan-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    const errEl = $('#plan-errors');
    if (!file) return;
    try {
      const text = await file.text();
      let plan;
      try {
        plan = JSON.parse(text);
      } catch (e) {
        showErrors(errEl, [{ file: null, line: null, message: `方案不是合法的 JSON：${e.message}` }]);
        return;
      }
      const { status, data } = await postJSON('/api/plan/import', {
        roundId: state.roundId,
        decisions: state.decisions,
        plan,
      });
      if (status === 404 && data.stage === 'round') {
        showErrors($('#upload-errors'), data.errors || []);
        handleRoundExpired();
        return;
      }
      if (!data.ok) {
        // 格式错误（stage=plan 等）时服务端未改动任何裁决，前端同样保持原状
        showErrors(errEl, data.errors || [{ file: null, line: null, message: '方案导入失败' }]);
        return;
      }
      errEl.classList.add('hidden');
      state.decisions = adoptDecisions(data.decisions);
      renderPlanReport(data.report);
      renderTable();
      updateResolutionState();
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `方案导入失败：${e.message}` }]);
    } finally {
      ev.target.value = '';
    }
  });

  // ---------- 导出 ----------
  $('#btn-export').addEventListener('click', async () => {
    const errEl = $('#export-errors');
    try {
      const resp = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roundId: state.roundId, decisions: state.decisions }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ errors: [] }));
        if (resp.status === 404 && data.stage === 'round') {
          showErrors($('#upload-errors'), data.errors || []);
          handleRoundExpired();
          return;
        }
        showErrors(errEl, data.errors || [{ file: null, line: null, message: '导出被拒绝' }]);
        return;
      }
      errEl.classList.add('hidden');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merged.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErrors(errEl, [{ file: null, line: null, message: `导出失败：${e.message}` }]);
    }
  });
})();
