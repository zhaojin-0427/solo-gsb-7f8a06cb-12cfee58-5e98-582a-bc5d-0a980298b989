'use strict';

/**
 * 三方合并引擎（基准 / 本地 / 远端）。
 *
 * 自动合并规则：
 *  - 单侧修改单元格：直接采纳
 *  - 两侧做相同修改：只采纳一次
 *  - 单侧删除整行 / 两侧都删除：删除
 *  - 单侧新增整行：采纳
 *
 * 冲突规则：
 *  - 同一单元格两侧改成不同值 → cell（可选本地/远端/手填）
 *  - 同一行一侧删除、另一侧修改 → row-delete-modify（整行保留或删除）
 *  - 同一键两侧都新增但内容不同 → row-add-divergent（行保留或删除；
 *    保留时逐单元格用本地/远端/手填解决）
 *  - 同一键两侧都新增且内容完全一致 → 自动新增
 */

const LABELS = {
  base: '基准',
  local: '本地',
  remote: '远端',
};

/**
 * 只读取对象自身的键（不碰原型链）。唯一键可能是 "__proto__" / "constructor"
 * 等与 Object.prototype 继承属性重名的合法字符串，直接 obj[key] 会读到继承属性
 * （或触发 __proto__ 存取器），造成行与行之间的裁决串扰；所有按唯一键存取
 * 裁决的地方都必须经此函数。
 */
function ownProp(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * 以唯一键为键的映射必须用无原型对象，使 "__proto__" 等键只是普通自有属性。
 */
function keyedMap() {
  return Object.create(null);
}

/**
 * 校验键列：键必须存在、非空、文件内唯一。
 * @returns {Array<{file:string, line:number|null, message:string}>}
 */
function validateKeys(parsed, keyColumn) {
  const errors = [];
  for (const label of ['base', 'local', 'remote']) {
    const { headers, rows } = parsed[label];
    if (!headers.includes(keyColumn)) {
      errors.push({ file: label, line: 1, message: `不存在键列 "${keyColumn}"` });
      continue;
    }
    const keyIdx = headers.indexOf(keyColumn);
    const seen = new Map();
    for (const rec of rows) {
      const key = rec.cells[keyIdx];
      if (key === undefined || key.trim() === '') {
        errors.push({ file: label, line: rec.line, message: '键值为空' });
        continue;
      }
      if (seen.has(key)) {
        errors.push({
          file: label,
          line: rec.line,
          message: `键 "${key}" 重复（最早出现于第 ${seen.get(key)} 行）`,
        });
      } else {
        seen.set(key, rec.line);
      }
    }
  }
  return errors;
}

function buildIndex(parsed, keyColumn) {
  const idx = parsed.headers.indexOf(keyColumn);
  const map = new Map();
  for (const rec of parsed.rows) {
    const key = rec.cells[idx];
    if (key === undefined || key.trim() === '') continue;
    map.set(key, rec);
  }
  return map;
}

/**
 * 比较基准与某一侧的一行，返回发生修改的列下标（不含键列）。
 */
function changedColumns(baseCells, sideCells, keyIdx) {
  const changed = [];
  for (let c = 0; c < baseCells.length; c++) {
    if (c === keyIdx) continue;
    if ((baseCells[c] || '') !== (sideCells[c] || '')) changed.push(c);
  }
  return changed;
}

/**
 * 计算三方合并结果。
 *
 * @returns {{
 *   headers: string[],
 *   keyColumn: string,
 *   keyIndex: number,
 *   rows: Array<MergeRow>,
 *   summary: object,
 * }}
 *
 * MergeRow:
 *   { key, base:{line,cells}|null, local:{line,cells}|null, remote:{...}|null,
 *     status, changes:{local:number[], remote:number[]},
 *     conflicts: Array<{type, column?, options:[...] }>,
 *     autoCells: number[] }
 * status: unchanged | modified | deleted | added | conflict
 */
function buildMerge(parsed, keyColumn) {
  const headers = parsed.base.headers;
  const keyIdx = headers.indexOf(keyColumn);
  const baseMap = buildIndex(parsed.base, keyColumn);
  const localMap = buildIndex(parsed.local, keyColumn);
  const remoteMap = buildIndex(parsed.remote, keyColumn);

  // 键的展示顺序：基准顺序优先，两侧新增的键随后（本地先、远端后）
  const orderedKeys = [];
  const addKey = (k) => {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  };
  for (const k of baseMap.keys()) addKey(k);
  for (const k of localMap.keys()) if (!baseMap.has(k)) addKey(k);
  for (const k of remoteMap.keys()) if (!baseMap.has(k)) addKey(k);

  /** @type {Array<MergeRow>} */
  const mergeRows = [];
  const summary = {
    total: 0,
    unchanged: 0,
    modified: 0,
    deleted: 0,
    added: 0,
    conflict: 0,
    rowConflicts: 0,
    cellConflicts: 0,
  };

  for (const key of orderedKeys) {
    const base = baseMap.get(key) || null;
    const local = localMap.get(key) || null;
    const remote = remoteMap.get(key) || null;

    const row = {
      key,
      keyIndex: keyIdx,
      base: base ? { line: base.line, cells: base.cells } : null,
      local: local ? { line: local.line, cells: local.cells } : null,
      remote: remote ? { line: remote.line, cells: remote.cells } : null,
      status: 'unchanged',
      changes: { local: [], remote: [] },
      conflicts: [],
      autoCells: [],
    };
    summary.total++;

    if (base) {
      row.changes.local = local ? changedColumns(base.cells, local.cells, keyIdx) : [];
      row.changes.remote = remote ? changedColumns(base.cells, remote.cells, keyIdx) : [];

      const localDeleted = !local;
      const remoteDeleted = !remote;

      if (localDeleted && remoteDeleted) {
        // 两侧都删除：自动删除
        row.status = 'deleted';
      } else if (localDeleted || remoteDeleted) {
        const deleter = localDeleted ? 'local' : 'remote';
        const modifier = localDeleted ? 'remote' : 'local';
        if (row.changes[modifier].length > 0) {
          // 删除 vs 修改 → 行级冲突
          row.status = 'conflict';
          row.conflicts.push({
            type: 'row-delete-modify',
            deleter,
            modifier,
          });
        } else {
          // 一侧删除，另一侧没动：自动删除
          row.status = 'deleted';
        }
      } else {
        // 两侧都存在：逐单元格比较
        const cellConflicts = [];
        for (const c of row.changes.local) {
          if (c === keyIdx) continue;
          const lv = local.cells[c];
          const rv = remote.cells[c];
          const bv = base.cells[c] || '';
          if (lv === rv) {
            // 相同修改（或恰好相同的值）：自动采纳一次
            row.autoCells.push(c);
          } else if (rv === bv) {
            // 仅本地修改：自动采纳本地
            row.autoCells.push(c);
          } else {
            // 两侧改成不同值 → 单元格冲突
            cellConflicts.push({ type: 'cell', column: c });
          }
        }
        for (const c of row.changes.remote) {
          if (c === keyIdx || row.changes.local.includes(c)) continue;
          // 本地没改这一列：自动采纳远端
          row.autoCells.push(c);
        }

        if (cellConflicts.length > 0) {
          row.status = 'conflict';
          row.conflicts.push(...cellConflicts);
        } else if (row.changes.local.length > 0 || row.changes.remote.length > 0) {
          row.status = 'modified';
        } else {
          row.status = 'unchanged';
        }
      }
    } else {
      // 基准没有：新增
      if (local && remote) {
        const same = headers.every((_, c) => local.cells[c] === remote.cells[c]);
        if (same) {
          row.status = 'added';
        } else {
          // 两侧都新增但内容不同 → 行级冲突，保留时逐格选择
          row.status = 'conflict';
          row.conflicts.push({
            type: 'row-add-divergent',
            differing: headers
              .map((_, c) => c)
              .filter((c) => c !== keyIdx && local.cells[c] !== remote.cells[c]),
          });
        }
      } else {
        // 单侧新增：自动新增
        row.status = 'added';
      }
    }

    if (row.status === 'conflict') {
      // conflict 计数由下方 summary[row.status]++ 统一累加，这里只统计细分项
      const hasRowConflict = row.conflicts.some(
        (cf) => cf.type === 'row-delete-modify' || cf.type === 'row-add-divergent',
      );
      if (hasRowConflict) summary.rowConflicts++;
      summary.cellConflicts += row.conflicts.filter((cf) => cf.type === 'cell').length;
    }
    summary[row.status]++;
    mergeRows.push(row);
  }

  return { headers, keyColumn, keyIndex: keyIdx, rows: mergeRows, summary };
}

/**
 * 根据用户决策生成最终行，并逐格记录取值来源（来源账本的数据基础）。
 *
 * 每个最终单元格附带一条来源记录：
 *   source: 'base'   未改动，取基准值
 *           'local'  仅本地修改 / 裁决取本地 / 仅本地新增
 *           'remote' 仅远端修改 / 裁决取远端 / 仅远端新增
 *           'both'   两侧改成（或新增为）相同的值
 *           'manual' 人工手填
 *   lines:  取值来源文件中的物理行号，如 { base: 2 } / { local: 3, remote: 4 }；
 *           人工手填没有来源行号，记 null（不虚构行号）。
 *
 * decisions（按唯一键存取，内部使用无原型对象，支持 "__proto__" 等合法键）:
 *   rowConflicts: { [key]: 'keep' | 'delete' }
 *   cells: { [key]: { [columnIndex]: { choice: 'local'|'remote'|'manual', value?: string } } }
 *
 * @returns {{
 *   cells: string[], sources: Array<{source: string, lines: object|null}>,
 *   key: string, deleted: boolean, deleteReason: string|null,
 *   unresolved: Array<string>,
 * }}
 */
function resolveRowProvenance(row, decisions, headers) {
  const unresolved = [];
  const key = row.key;

  // 行级冲突的去留
  let deleted = row.status === 'deleted';
  // 自动删除 / 裁决删除的原因（删除键在账本中单独列出）
  let deleteReason = null;
  if (deleted) {
    if (!row.local && !row.remote) deleteReason = 'both-deleted';
    else if (!row.local) deleteReason = 'local-deleted';
    else deleteReason = 'remote-deleted';
  }
  const rowConflict = row.conflicts.find(
    (cf) => cf.type === 'row-delete-modify' || cf.type === 'row-add-divergent',
  );
  if (rowConflict) {
    const d = ownProp(decisions.rowConflicts, key);
    if (!d) unresolved.push('行级冲突未决定保留/删除');
    else if (d === 'delete') {
      deleted = true;
      deleteReason =
        rowConflict.type === 'row-delete-modify'
          ? 'decision-delete-modify'
          : 'decision-add-divergent';
    }
  }

  if (deleted) {
    return { key, cells: [], sources: [], deleted: true, deleteReason, unresolved };
  }

  const ref = row.base || row.local || row.remote;
  const cells = ref.cells.slice();
  const sources = new Array(cells.length).fill(null);

  const sideLine = (side) => (row[side] ? row[side].line : null);
  const fromBase = (c) => {
    sources[c] = { source: 'base', lines: { base: sideLine('base') } };
  };
  const fromSide = (c, side) => {
    sources[c] = { source: side, lines: { [side]: sideLine(side) } };
  };
  const fromBoth = (c) => {
    sources[c] = {
      source: 'both',
      lines: { local: sideLine('local'), remote: sideLine('remote') },
    };
  };
  const fromManual = (c) => {
    sources[c] = { source: 'manual', lines: null };
  };
  const fromDecision = (c, dec) => {
    if (dec.choice === 'local') fromSide(c, 'local');
    else if (dec.choice === 'remote') fromSide(c, 'remote');
    else fromManual(c);
  };

  // 基准存在的行：所有列先按"未改动取基准"记账，后续改动再覆盖
  if (row.base) {
    for (let c = 0; c < cells.length; c++) fromBase(c);
  }

  // 从一个参考行起步，再叠加各侧的值
  if (row.status === 'unchanged') {
    // cells 即基准
  } else if (row.status === 'added') {
    // 单侧新增 / 双侧相同新增：用任一存在的侧
    const src = row.local || row.remote;
    const bothAdded = row.local && row.remote;
    for (let c = 0; c < cells.length; c++) {
      cells[c] = src.cells[c];
      if (bothAdded) fromBoth(c);
      else fromSide(c, row.local ? 'local' : 'remote');
    }
  } else if (row.status === 'modified') {
    // 自动合并：单侧修改采纳，相同修改采纳
    if (row.local)
      for (const c of row.changes.local) {
        cells[c] = row.local.cells[c];
        fromSide(c, 'local');
      }
    if (row.remote)
      for (const c of row.changes.remote) {
        if (!row.changes.local.includes(c)) {
          cells[c] = row.remote.cells[c];
          fromSide(c, 'remote');
        } else if (row.local.cells[c] === row.remote.cells[c]) {
          cells[c] = row.remote.cells[c];
          fromBoth(c);
        }
      }
  }

  if (row.status === 'conflict') {
    if (rowConflict && rowConflict.type === 'row-add-divergent') {
      // 双侧新增且保留：默认以本地为底，逐格按决策覆盖
      for (let c = 0; c < cells.length; c++) {
        cells[c] = row.local ? row.local.cells[c] : row.remote.cells[c];
        // 非分歧列两侧新增值相同，记两侧；分歧列先按本地记账，决策后覆盖
        if (rowConflict.differing.includes(c)) fromSide(c, 'local');
        else fromBoth(c);
      }
      for (const c of rowConflict.differing) {
        const dec = ownProp(ownProp(decisions.cells, key), c);
        if (!dec) {
          unresolved.push(`新增行第 ${c + 1} 列未选择取值`);
          continue;
        }
        cells[c] = pickCell(row, c, dec);
        fromDecision(c, dec);
      }
    } else {
      // 删除/修改冲突（保留）或纯单元格冲突：以基准为底，叠加未冲突的单侧/相同修改，
      // 再应用单元格决策。某一侧整行删除时，该侧不贡献任何值。
      const delMod = row.conflicts.find((cf) => cf.type === 'row-delete-modify');
      const localDeleted = !row.local;
      const remoteDeleted = !row.remote;
      // 删除/修改冲突中唯一的修改侧
      const onlyModifier = delMod ? delMod.modifier : null;

      if (!localDeleted)
        for (const c of row.changes.local) {
          const isCellConflict = row.conflicts.some((cf) => cf.type === 'cell' && cf.column === c);
          if (isCellConflict) continue;
          // 对侧已删除整行时，本地的值只在"本地是修改侧"时采纳
          if (remoteDeleted && onlyModifier !== 'local') continue;
          cells[c] = row.local.cells[c];
          fromSide(c, 'local');
        }
      if (!remoteDeleted)
        for (const c of row.changes.remote) {
          const isCellConflict = row.conflicts.some((cf) => cf.type === 'cell' && cf.column === c);
          if (isCellConflict) continue;
          if (localDeleted) {
            // 对侧已删除整行：只有远端是修改侧才采纳
            if (onlyModifier === 'remote') {
              cells[c] = row.remote.cells[c];
              fromSide(c, 'remote');
            }
            continue;
          }
          const localChangedSame = row.changes.local.includes(c)
            ? row.local.cells[c] === row.remote.cells[c]
            : false;
          if (localChangedSame) {
            cells[c] = row.remote.cells[c];
            fromBoth(c);
          } else if (!row.changes.local.includes(c)) {
            cells[c] = row.remote.cells[c];
            fromSide(c, 'remote');
          }
        }
      for (const cf of row.conflicts) {
        if (cf.type !== 'cell') continue;
        const c = cf.column;
        const dec = ownProp(ownProp(decisions.cells, key), c);
        if (!dec) {
          unresolved.push(`单元格冲突（列 "${headers[c]}"，第 ${c + 1} 列）未解决`);
          continue;
        }
        cells[c] = pickCell(row, c, dec);
        fromDecision(c, dec);
      }
    }
  }

  // 保证键列永远是当前键；键列来源：基准行记基准，新增行记新增侧（两侧同键记两侧）
  cells[row.keyIndex] = key;
  if (row.base) fromBase(row.keyIndex);
  else if (row.local && row.remote) fromBoth(row.keyIndex);
  else fromSide(row.keyIndex, row.local ? 'local' : 'remote');

  return { key, cells, sources, deleted: false, deleteReason: null, unresolved };
}

function pickCell(row, c, dec) {
  if (dec.choice === 'local') return (row.local ? row.local.cells[c] : '') || '';
  if (dec.choice === 'remote') return (row.remote ? row.remote.cells[c] : '') || '';
  return dec.value != null ? dec.value : '';
}

/**
 * 根据用户决策生成最终行（不带来源信息）。
 * 与来源账本共用 resolveRowProvenance 的同一套计算，保证两边逐格取值一致。
 *
 * @returns {{ cells: string[], key: string, deleted: boolean, unresolved: Array<string> }}
 */
function resolveRow(row, decisions, headers) {
  const r = resolveRowProvenance(row, decisions, headers);
  return { key: r.key, cells: r.cells, deleted: r.deleted, unresolved: r.unresolved };
}

/**
 * 汇总导出。
 * @returns {{ rows: string[][], unresolved: number, unresolvedDetails: string[] }}
 */
function resolveAll(model, decisions) {
  const outRows = [];
  const unresolvedDetails = [];
  const byKey = new Map();

  for (const row of model.rows) {
    const res = resolveRow(row, decisions, model.headers);
    byKey.set(row.key, res);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
  }

  // 沿用基准表头顺序：先基准键序，再追加新增键
  for (const row of model.rows) {
    const res = byKey.get(row.key);
    if (!res.deleted) outRows.push(res.cells);
  }

  return { rows: outRows, unresolved: unresolvedDetails.length, unresolvedDetails };
}

module.exports = {
  LABELS,
  validateKeys,
  buildMerge,
  resolveAll,
  resolveRowProvenance,
  ownProp,
  keyedMap,
};
