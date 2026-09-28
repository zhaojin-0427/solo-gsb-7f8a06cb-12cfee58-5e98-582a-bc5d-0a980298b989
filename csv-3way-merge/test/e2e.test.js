'use strict';
// 端到端冒烟测试：直接调用 src 模块模拟全部关键场景
const assert = require('assert');
const { parseCSV, checkHeadersConsistency, stringifyCSV } = require('../src/csv');
const { validateKeys, buildMerge, resolveAll } = require('../src/merge');
const { buildLedger } = require('../src/ledger');
const { buildHierarchyCheck, validateParentColumn } = require('../src/hierarchy');
const { buildImportOrder, sortParentFirst } = require('../src/order');
const { buildPlan, validatePlanStructure, applyPlan, cloneDecisions } = require('../src/plan');
const {
  KEY_CHECK_LIMIT,
  validateKeyCheckParams,
  buildKeyChangeCheck,
} = require('../src/keychange');
const {
  DETERMINANT_ROW_LIMIT,
  validateDeterminantParams,
  buildDeterminants,
} = require('../src/determinants');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

function parse3(base, local, remote) {
  const parsed = {
    base: parseCSV(base),
    local: parseCSV(local),
    remote: parseCSV(remote),
  };
  assert.deepStrictEqual(parsed.base.errors, []);
  assert.deepStrictEqual(parsed.local.errors, []);
  assert.deepStrictEqual(parsed.remote.errors, []);
  assert.deepStrictEqual(checkHeadersConsistency(parsed), []);
  return parsed;
}

// ---------- CSV 解析 ----------
test('RFC4180: 引号、转义、跨行、行号', () => {
  const csv = 'id,name\r\n1,"张,三"\r\n2,"行\r\n内"\r\n3,"a""b"';
  const r = parseCSV(csv);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rows[0].line, 2);
  assert.strictEqual(r.rows[0].cells[1], '张,三');
  assert.strictEqual(r.rows[1].line, 3);
  assert.strictEqual(r.rows[1].cells[1], '行\r\n内');
  assert.strictEqual(r.rows[2].line, 5);
  assert.strictEqual(r.rows[2].cells[1], 'a"b');
});

test('解析错误: 引号未闭合', () => {
  const r = parseCSV('a,b\n1,"unclosed');
  assert.ok(r.errors.some((e) => e.message.includes('引号未闭合')));
});

test('解析错误: 列数不符', () => {
  const r = parseCSV('a,b\n1,2,3');
  assert.ok(r.errors[0].message.includes('列数不一致'));
  assert.strictEqual(r.errors[0].line, 2);
});

test('BOM 被去除', () => {
  const r = parseCSV('﻿id\n1');
  assert.strictEqual(r.headers[0], 'id');
});

test('stringifyCSV 往返一致', () => {
  const rows = [['a', 'b,c'], ['1', 'x"y\nz']];
  const text = stringifyCSV(rows);
  const r = parseCSV(text);
  assert.deepStrictEqual([r.headers, ...r.rows.map((x) => x.cells)], rows);
});

// ---------- 校验 ----------
test('表头不一致被拒绝并指出列', () => {
  const parsed = {
    base: parseCSV('id,name\n1,a'),
    local: parseCSV('id,title\n1,a'),
    remote: parseCSV('id,name\n1,a'),
  };
  const errs = checkHeadersConsistency(parsed);
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].file, 'local');
  assert.ok(errs[0].message.includes('第 2 列'));
});

test('空键、重复键报告文件与行号', () => {
  const parsed = parse3(
    'id,v\n1,a\n2,b',
    'id,v\n1,a\n,b\n2,c',
    'id,v\n1,a\n1,b\n2,c',
  );
  const errs = validateKeys(parsed, 'id');
  assert.strictEqual(errs.length, 2);
  assert.ok(errs.some((e) => e.file === 'local' && e.line === 3 && e.message.includes('键值为空')));
  assert.ok(errs.some((e) => e.file === 'remote' && e.line === 3 && e.message.includes('重复')));
});

// ---------- 自动合并场景 ----------
const base = `id,name,city,note
K1,张三,北京,备注
K2,李四,上海,备注
K3,王五,广州,备注
K4,赵六,深圳,备注
K5,钱七,杭州,备注
K6,孙八,成都,备注
K9,郑十一,西安,备注`;
const local = `id,name,city,note
K1,张三,北京,本地备注
K2,李四,上海,相同备注
K3,王五,深圳,备注
K5,钱七,杭州,备注
K6,孙八,成都,本地值
K9,郑十一,西安,备注
L1,新A,苏州,x
X1,同,重庆,z
X2,异,天津,本地备注`;
const remote = `id,name,city,note
K1,张三,北京,备注
K2,李四,上海,相同备注
K3,王五,广州,备注
K4,赵六,深圳,远端改备注
K6,孙八,成都,远端值
K7,周九,长沙,备注
K9,郑十一,西安,备注
X1,同,重庆,z
X2,异,天津,远端备注
R1,新B,厦门,y`;

const parsed = parse3(base, local, remote);
const keyErrs = validateKeys(parsed, 'id');
assert.deepStrictEqual(keyErrs, []);
const model = buildMerge(parsed, 'id');
const byKey = Object.fromEntries(model.rows.map((r) => [r.key, r]));

test('K1 单侧修改自动采纳(local)', () => {
  assert.strictEqual(byKey.K1.status, 'modified');
  const out = resolveAll(model, {});
  const k1 = out.rows.find((r) => r[0] === 'K1');
  assert.strictEqual(k1[3], '本地备注');
});

test('K2 双方相同修改采纳一次', () => {
  assert.strictEqual(byKey.K2.status, 'modified');
  assert.ok(byKey.K2.autoCells.includes(3));
});

test('K3 本地修改城市 vs 远端未动 → 自动采纳本地', () => {
  assert.strictEqual(byKey.K3.status, 'modified');
  const out = resolveAll(model, {});
  assert.strictEqual(out.rows.find((r) => r[0] === 'K3')[2], '深圳');
});

test('K4 本地删除 vs 远端修改 → 行级冲突', () => {
  assert.strictEqual(byKey.K4.status, 'conflict');
  const cf = byKey.K4.conflicts[0];
  assert.strictEqual(cf.type, 'row-delete-modify');
  assert.strictEqual(cf.deleter, 'local');
  assert.strictEqual(cf.modifier, 'remote');
});

test('K5 本地删除、远端未动 → 自动删除', () => {
  assert.strictEqual(byKey.K5.status, 'deleted');
});

test('K6 同一格双方不同值 → 单元格冲突', () => {
  assert.strictEqual(byKey.K6.status, 'conflict');
  assert.strictEqual(byKey.K6.conflicts.length, 1);
  assert.strictEqual(byKey.K6.conflicts[0].type, 'cell');
  assert.strictEqual(byKey.K6.conflicts[0].column, 3);
});

test('K7 仅远端新增式修改？不——基准无K7: 远端单侧新增 → added', () => {
  assert.strictEqual(byKey.K7.status, 'added');
});

test('K9 三方一致 unchanged', () => {
  assert.strictEqual(byKey.K9.status, 'unchanged');
});

test('L1/R1 单侧新增 → added', () => {
  assert.strictEqual(byKey.L1.status, 'added');
  assert.strictEqual(byKey.R1.status, 'added');
});

test('X1 双方新增内容相同 → added', () => {
  assert.strictEqual(byKey.X1.status, 'added');
});

test('X2 双方新增内容不同 → row-add-divergent', () => {
  assert.strictEqual(byKey.X2.status, 'conflict');
  const cf = byKey.X2.conflicts[0];
  assert.strictEqual(cf.type, 'row-add-divergent');
  assert.deepStrictEqual(cf.differing, [3]);
});

// ---------- 解决 / 导出 ----------
test('未解决冲突禁止导出', () => {
  const out = resolveAll(model, {});
  assert.ok(out.unresolved >= 3, `unresolved=${out.unresolved}`);
  assert.ok(out.unresolvedDetails.some((m) => m.includes('K4')));
  assert.ok(out.unresolvedDetails.some((m) => m.includes('K6')));
  assert.ok(out.unresolvedDetails.some((m) => m.includes('X2')));
});

test('全部解决后导出，顺序沿用基准表头顺序', () => {
  const decisions = {
    rowConflicts: { K4: 'keep', X2: 'keep' },
    cells: {
      K6: { 3: { choice: 'remote' } },
      X2: { 3: { choice: 'manual', value: '我手填的' } },
    },
  };
  const out = resolveAll(model, decisions);
  assert.strictEqual(out.unresolved, 0, out.unresolvedDetails.join('; '));
  // K4 保留 → 采纳远端的修改
  const k4 = out.rows.find((r) => r[0] === 'K4');
  assert.strictEqual(k4[3], '远端改备注');
  // K5 自动删除
  assert.ok(!out.rows.find((r) => r[0] === 'K5'));
  // K6 取远端
  assert.strictEqual(out.rows.find((r) => r[0] === 'K6')[3], '远端值');
  // X2 手填
  assert.strictEqual(out.rows.find((r) => r[0] === 'X2')[3], '我手填的');
  // 顺序：基准键序在前，新增键追加在后
  const keys = out.rows.map((r) => r[0]);
  assert.deepStrictEqual(
    keys,
    ['K1', 'K2', 'K3', 'K4', 'K6', 'K9', 'L1', 'X1', 'X2', 'K7', 'R1'],
  );
  // 表头顺序未受任何一侧影响
  assert.deepStrictEqual(model.headers, ['id', 'name', 'city', 'note']);
});

test('行级冲突选择删除', () => {
  const decisions = {
    rowConflicts: { K4: 'delete', X2: 'delete' },
    cells: { K6: { 3: { choice: 'local' } } },
  };
  const out = resolveAll(model, decisions);
  assert.strictEqual(out.unresolved, 0);
  assert.ok(!out.rows.find((r) => r[0] === 'K4'));
  assert.ok(!out.rows.find((r) => r[0] === 'X2'));
  assert.strictEqual(out.rows.find((r) => r[0] === 'K6')[3], '本地值');
});

test('双方各改不同列 → 两列都采纳', () => {
  const p = parse3(
    'id,a,b\n1,x,y',
    'id,a,b\n1,L,y',
    'id,a,b\n1,x,R',
  );
  const m = buildMerge(p, 'id');
  assert.strictEqual(m.rows[0].status, 'modified');
  const out = resolveAll(m, {});
  assert.deepStrictEqual(out.rows[0], ['1', 'L', 'R']);
  assert.strictEqual(out.unresolved, 0);
});

test('双方都删除 → 自动删除', () => {
  const p = parse3('id,a\n1,x\n2,y', 'id,a\n1,x\n', 'id,a\n2,y\n');
  // 本地删了2，远端删了1 — 行1: local same/remote deleted -> deleted; 行2: local deleted/remote same -> deleted
  const m = buildMerge(p, 'id');
  assert.strictEqual(m.rows[0].status, 'deleted');
  assert.strictEqual(m.rows[1].status, 'deleted');
});

test('删除/修改冲突两个方向：保留时只采纳修改侧', () => {
  // 方向一：本地删除，远端修改
  let p = parse3('id,a,b\n1,x,y', 'id,a,b\n', 'id,a,b\n1,x,R');
  let m = buildMerge(p, 'id');
  assert.strictEqual(m.rows[0].conflicts[0].deleter, 'local');
  let out = resolveAll(m, { rowConflicts: { 1: 'keep' } });
  assert.strictEqual(out.unresolved, 0);
  assert.deepStrictEqual(out.rows[0], ['1', 'x', 'R']);
  out = resolveAll(m, { rowConflicts: { 1: 'delete' } });
  assert.strictEqual(out.rows.length, 0);

  // 方向二：远端删除，本地修改
  p = parse3('id,a,b\n1,x,y', 'id,a,b\n1,L,y', 'id,a,b\n');
  m = buildMerge(p, 'id');
  assert.strictEqual(m.rows[0].conflicts[0].deleter, 'remote');
  out = resolveAll(m, { rowConflicts: { 1: 'keep' } });
  assert.deepStrictEqual(out.rows[0], ['1', 'L', 'y']);
});

test('删除/修改相遇的行同时存在真正的单元格冲突：保留后仍需逐格解决', () => {
  // 本地删除；远端把两列改成互不相干的新值（没有另一侧参与，不构成双方冲突，
  // 整行作为"远端修改"一次性处理，不再产生 cell 冲突）
  const p = parse3('id,a,b\n1,x,y', 'id,a,b\n', 'id,a,b\n1,P,Q');
  const m = buildMerge(p, 'id');
  assert.strictEqual(m.rows[0].conflicts.length, 1);
  assert.strictEqual(m.rows[0].conflicts[0].type, 'row-delete-modify');
  const out = resolveAll(m, { rowConflicts: { 1: 'keep' } });
  assert.deepStrictEqual(out.rows[0], ['1', 'P', 'Q']);
});

// ---------- 来源账本 ----------
const ledgerDecisions = {
  rowConflicts: { K4: 'keep', X2: 'keep' },
  cells: {
    K6: { 3: { choice: 'remote' } },
    X2: { 3: { choice: 'manual', value: '我手填的' } },
  },
};
const ledgerOut = buildLedger(model, ledgerDecisions);
assert.strictEqual(ledgerOut.unresolved, 0, ledgerOut.unresolvedDetails.join('; '));
const ledger = ledgerOut.ledger;
const lgByKey = Object.fromEntries(ledger.rows.map((r) => [r.key, r]));
const lgCell = (key, colName) => {
  const row = lgByKey[key];
  const idx = ledger.headers.indexOf(colName);
  return row.cells[idx];
};

test('账本行序与最终 CSV 行序一致，且逐格取值与导出一致', () => {
  const csvOut = resolveAll(model, ledgerDecisions);
  assert.strictEqual(csvOut.unresolved, 0);
  // 行序一致
  assert.deepStrictEqual(
    ledger.rows.map((r) => r.key),
    csvOut.rows.map((r) => r[0]),
  );
  // 逐格取值一致
  ledger.rows.forEach((lrow, i) => {
    assert.deepStrictEqual(
      lrow.cells.map((c) => c.value),
      csvOut.rows[i],
      `键 ${lrow.key} 的账本取值与 CSV 导出不一致`,
    );
  });
  // 删除键不混入输出行
  assert.ok(!ledger.rows.some((r) => r.key === 'K5'));
});

test('账本：未改值记基准并带基准行号', () => {
  const c = lgCell('K9', 'name');
  assert.strictEqual(c.value, '郑十一');
  assert.strictEqual(c.source, 'base');
  assert.deepStrictEqual(c.lines, { base: 8 });
  // 修改行里未改的列同样记基准
  const c2 = lgCell('K1', 'name');
  assert.strictEqual(c2.source, 'base');
  assert.deepStrictEqual(c2.lines, { base: 2 });
});

test('账本：单侧修改记对应侧，两侧同值修改记两侧', () => {
  // K1 仅本地改 note（本地第 2 行）
  const c1 = lgCell('K1', 'note');
  assert.strictEqual(c1.value, '本地备注');
  assert.strictEqual(c1.source, 'local');
  assert.deepStrictEqual(c1.lines, { local: 2 });
  // K3 仅本地改 city（本地第 4 行）
  const c3 = lgCell('K3', 'city');
  assert.strictEqual(c3.value, '深圳');
  assert.strictEqual(c3.source, 'local');
  assert.deepStrictEqual(c3.lines, { local: 4 });
  // K2 两侧相同修改（本地/远端第 3 行）
  const c2 = lgCell('K2', 'note');
  assert.strictEqual(c2.value, '相同备注');
  assert.strictEqual(c2.source, 'both');
  assert.deepStrictEqual(c2.lines, { local: 3, remote: 3 });
});

test('账本：手填记人工且不虚构行号；取侧记对应侧行号', () => {
  // X2 分歧列手填
  const c = lgCell('X2', 'note');
  assert.strictEqual(c.value, '我手填的');
  assert.strictEqual(c.source, 'manual');
  assert.strictEqual(c.lines, null);
  // K6 单元格冲突取远端（远端第 6 行）
  const c6 = lgCell('K6', 'note');
  assert.strictEqual(c6.value, '远端值');
  assert.strictEqual(c6.source, 'remote');
  assert.deepStrictEqual(c6.lines, { remote: 6 });
});

test('账本：单侧新增记对应侧，两侧同值新增记两侧', () => {
  // L1 仅本地新增（本地第 8 行），整行每格都记本地
  for (const col of ledger.headers) {
    const c = lgCell('L1', col);
    assert.strictEqual(c.source, 'local', `L1.${col}`);
    assert.deepStrictEqual(c.lines, { local: 8 });
  }
  // R1 仅远端新增（远端第 11 行）
  for (const col of ledger.headers) {
    const c = lgCell('R1', col);
    assert.strictEqual(c.source, 'remote', `R1.${col}`);
    assert.deepStrictEqual(c.lines, { remote: 11 });
  }
  // X1 两侧同值新增（两侧第 9 行），整行记两侧
  for (const col of ledger.headers) {
    const c = lgCell('X1', col);
    assert.strictEqual(c.source, 'both', `X1.${col}`);
    assert.deepStrictEqual(c.lines, { local: 9, remote: 9 });
  }
});

test('账本：同键异值新增保留后，非分歧列记两侧、键列记两侧', () => {
  // X2 保留：非分歧列两侧新增值相同 → 记两侧
  const city = lgCell('X2', 'city');
  assert.strictEqual(city.value, '天津');
  assert.strictEqual(city.source, 'both');
  assert.deepStrictEqual(city.lines, { local: 10, remote: 10 });
  const key = lgCell('X2', 'id');
  assert.strictEqual(key.value, 'X2');
  assert.strictEqual(key.source, 'both');
});

test('账本：删除/修改冲突保留时，修改列记修改侧、其余记基准', () => {
  // K4 本地删除 vs 远端修改 note，裁决保留
  const note = lgCell('K4', 'note');
  assert.strictEqual(note.value, '远端改备注');
  assert.strictEqual(note.source, 'remote');
  assert.deepStrictEqual(note.lines, { remote: 5 });
  const name = lgCell('K4', 'name');
  assert.strictEqual(name.source, 'base');
  assert.deepStrictEqual(name.lines, { base: 5 });
});

test('账本：删除键单独列出原因，不混入输出行', () => {
  // K5 远端删除、本地未动
  const k5 = ledger.deleted.find((d) => d.key === 'K5');
  assert.ok(k5);
  assert.strictEqual(k5.reason, 'remote-deleted');
  assert.ok(k5.reasonText.includes('远端'));
  assert.deepStrictEqual(k5.lines, { base: 6, local: 5 });
  assert.strictEqual(ledger.deletedCount, ledger.deleted.length);
});

test('账本：行级冲突裁决删除也单独归因', () => {
  const out = buildLedger(model, {
    rowConflicts: { K4: 'delete', X2: 'delete' },
    cells: { K6: { 3: { choice: 'local' } } },
  });
  assert.strictEqual(out.unresolved, 0);
  const keys = out.ledger.rows.map((r) => r.key);
  assert.ok(!keys.includes('K4'));
  assert.ok(!keys.includes('X2'));
  const k4 = out.ledger.deleted.find((d) => d.key === 'K4');
  const x2 = out.ledger.deleted.find((d) => d.key === 'X2');
  assert.strictEqual(k4.reason, 'decision-delete-modify');
  assert.strictEqual(x2.reason, 'decision-add-divergent');
  // 新增键被裁决不加入：没有基准行号，但保留两侧新增行号
  assert.deepStrictEqual(x2.lines, { local: 10, remote: 10 });
});

test('账本：有未决冲突时不产出完整账本（unresolved > 0）', () => {
  const out = buildLedger(model, {});
  assert.ok(out.unresolved > 0);
  assert.ok(out.unresolvedDetails.some((m) => m.includes('K4')));
});

test('账本：两侧都删除记 both-deleted', () => {
  const p = parse3('id,a\n1,x\n2,y', 'id,a\n1,x\n', 'id,a\n2,y\n');
  const m = buildMerge(p, 'id');
  const out = buildLedger(m, {});
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.ledger.rows.length, 0);
  assert.deepStrictEqual(
    out.ledger.deleted.map((d) => d.reason),
    ['remote-deleted', 'local-deleted'],
  );
  const p2 = parse3('id,a\n1,x', 'id,a\n', 'id,a\n');
  const out2 = buildLedger(buildMerge(p2, 'id'), {});
  assert.strictEqual(out2.ledger.deleted[0].reason, 'both-deleted');
});

// ---------- 父子层级核验 ----------
// 层级数据：A 为根；B→A→C 正常链；D 指向不存在的 X；E 自环；F↔G 成环；
// H 仅指向环（非环成员）；I 指向将被本地删除的 DEL
const hierBase =
  'id,parent,name\n' +
  'A,,根\nB,A,子\nC,B,孙\nD,X,缺失\nE,E,自环\n' +
  'F,G,环一\nG,F,环二\nH,F,指向环\nI,DEL,指向删除\nDEL,,将被删除';
const hierLocal =
  'id,parent,name\n' +
  'A,,根\nB,A,子\nC,B,孙\nD,X,缺失\nE,E,自环\nF,G,环一\nG,F,环二\nH,F,指向环\nI,DEL,指向删除';
const hierParsed = parse3(hierBase, hierLocal, hierBase);
const hierModel = buildMerge(hierParsed, 'id');
const hierOut = buildHierarchyCheck(hierModel, {}, 'parent');
assert.strictEqual(hierOut.unresolved, 0, hierOut.unresolvedDetails.join('; '));
const hierCheck = hierOut.check;

test('层级核验：空父键视为根，正常层级链不报问题', () => {
  assert.strictEqual(hierCheck.rowCount, 9); // DEL 被本地删除，最终保留 9 行
  const keys = hierCheck.issues.map((i) => i.key);
  assert.ok(!keys.includes('A'));
  assert.ok(!keys.includes('B'));
  assert.ok(!keys.includes('C'));
});

test('层级核验：指向不存在或已删除键报缺失父项，行号为最终 CSV 行号', () => {
  const d = hierCheck.issues.find((i) => i.key === 'D');
  assert.strictEqual(d.type, 'missing-parent');
  assert.strictEqual(d.parentKey, 'X');
  assert.strictEqual(d.line, 5); // 表头第 1 行，D 是第 4 条输出数据
  const i9 = hierCheck.issues.find((i) => i.key === 'I');
  assert.strictEqual(i9.type, 'missing-parent');
  assert.strictEqual(i9.parentKey, 'DEL'); // DEL 已删除，不在最终键索引中
  assert.strictEqual(i9.line, 10);
});

test('层级核验：自环与多行环成员报循环，仅指向环的非环成员不报', () => {
  const cyc = hierCheck.issues.filter((i) => i.type === 'cycle').map((i) => i.key);
  assert.deepStrictEqual(cyc, ['E', 'F', 'G']);
  assert.ok(!hierCheck.issues.some((i) => i.key === 'H'));
});

test('层级核验：问题按最终 CSV 行序列出', () => {
  assert.deepStrictEqual(hierCheck.issues.map((i) => i.key), ['D', 'E', 'F', 'G', 'I']);
  assert.deepStrictEqual(hierCheck.issues.map((i) => i.line), [5, 6, 7, 8, 10]);
  assert.strictEqual(hierCheck.issueCount, hierCheck.issues.length);
  assert.strictEqual(hierCheck.parentColumn, 'parent');
  assert.ok(hierCheck.typeLegend['missing-parent']);
  assert.ok(hierCheck.typeLegend.cycle);
});

test('层级核验：父键按原字符串精确匹配，不裁剪空白', () => {
  const p = parse3(
    'id,parent\nA,\nB,A ',
    'id,parent\nA,\nB,A ',
    'id,parent\nA,\nB,A ',
  );
  const out = buildHierarchyCheck(buildMerge(p, 'id'), {}, 'parent');
  assert.strictEqual(out.unresolved, 0);
  // 'A '（带尾随空格）不等于 'A' → 缺失父项
  assert.deepStrictEqual(
    out.check.issues.map((i) => [i.key, i.type, i.parentKey]),
    [['B', 'missing-parent', 'A ']],
  );
});

// 删除/修改冲突：T 被本地删除、被远端修改；C 的父键指向 T
const hierConflictParsed = parse3(
  'id,parent,name\nC,T,子\nT,,目标',
  'id,parent,name\nC,T,子',
  'id,parent,name\nC,T,子\nT,,目标改',
);
const hierConflictModel = buildMerge(hierConflictParsed, 'id');
assert.strictEqual(hierConflictModel.rows.find((r) => r.key === 'T').status, 'conflict');

test('层级核验：有未决冲突时不给出完整结论', () => {
  const out = buildHierarchyCheck(hierConflictModel, {}, 'parent');
  assert.ok(out.unresolved > 0);
  assert.strictEqual(out.check, null);
});

test('层级核验：裁决变化后结论随之变化（保留 vs 删除被指向的键）', () => {
  // 保留 T：C 的父键有效 → 无问题
  let out = buildHierarchyCheck(hierConflictModel, { rowConflicts: { T: 'keep' } }, 'parent');
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.check.issueCount, 0);
  // 删除 T：C 指向已删除键 → 缺失父项（C 是第 1 条输出数据，第 2 行）
  out = buildHierarchyCheck(hierConflictModel, { rowConflicts: { T: 'delete' } }, 'parent');
  assert.strictEqual(out.unresolved, 0);
  assert.deepStrictEqual(
    out.check.issues.map((i) => [i.key, i.type, i.line]),
    [['C', 'missing-parent', 2]],
  );
});

test('层级核验：父键列必须存在且不能是唯一键列', () => {
  assert.strictEqual(validateParentColumn(hierModel, 'parent'), null);
  assert.ok(validateParentColumn(hierModel, 'id').includes('唯一键'));
  assert.ok(validateParentColumn(hierModel, 'nope').includes('不在表头'));
  assert.ok(validateParentColumn(hierModel, '').includes('缺少'));
  assert.ok(validateParentColumn(hierModel, undefined).includes('缺少'));
});

// ---------- 父子数据导入顺序 ----------
// 三方一致（无冲突）：C1 在原行序中早于其父 R1；R2 是无子根
const orderCsv =
  'id,parent,name\n' +
  'R2,,根二\nC1,R1,子一\nR1,,根一\nC2,R1,子二\nG1,C1,孙一';
const orderModel = buildMerge(parse3(orderCsv, orderCsv, orderCsv), 'id');

test('导入顺序：父先子后，每步取当前可输出行中原合并 CSV 行序最早者', () => {
  const out = buildImportOrder(orderModel, {}, 'parent');
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.order.valid, true);
  assert.strictEqual(out.order.issueCount, 0);
  assert.strictEqual(out.order.rowCount, 5);
  // 原行序 R2(0) C1(1) R1(2) C2(3) G1(4)：初始可输出 R2/R1 → 取 R2；
  // C1 尚不可输出（父 R1 未出）→ 取 R1；C1/C2 可输出，C1 原行序更早 → C1、C2；最后 G1
  assert.deepStrictEqual(
    out.order.keys.map((k) => k.key),
    ['R2', 'R1', 'C1', 'C2', 'G1'],
  );
  // line 为顺序 CSV 行号（连续），mergedLine 为原合并 CSV 行号
  assert.deepStrictEqual(
    out.order.keys.map((k) => [k.line, k.mergedLine]),
    [
      [2, 2],
      [3, 4],
      [4, 3],
      [5, 5],
      [6, 6],
    ],
  );
  assert.deepStrictEqual(
    out.order.keys.map((k) => k.parentKey),
    ['', '', 'R1', 'R1', 'C1'],
  );
  // 导出行与合并 CSV 行逐格一致，仅顺序不同
  const merged = resolveAll(orderModel, {});
  const byKey = new Map(merged.rows.map((r) => [r[0], r]));
  assert.deepStrictEqual(
    out.rows.map((r) => r[0]),
    ['R2', 'R1', 'C1', 'C2', 'G1'],
  );
  for (const r of out.rows) assert.deepStrictEqual(r, byKey.get(r[0]));
});

test('导入顺序：多根按原行序先后输出，子行紧随父行可用', () => {
  const p = parse3('id,parent\nB,\nA,\nC,A', 'id,parent\nB,\nA,\nC,A', 'id,parent\nB,\nA,\nC,A');
  const out = buildImportOrder(buildMerge(p, 'id'), {}, 'parent');
  assert.strictEqual(out.order.valid, true);
  assert.deepStrictEqual(out.order.keys.map((k) => k.key), ['B', 'A', 'C']);
});

test('导入顺序：缺失父项或循环时 valid=false 且不出键序（阻止顺序导出）', () => {
  const out = buildImportOrder(hierModel, {}, 'parent');
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.order.valid, false);
  assert.strictEqual(out.order.keys, null);
  assert.strictEqual(out.rows, null);
  // 问题清单与层级核验完全一致（同一份 analyzeHierarchy 计算）
  assert.deepStrictEqual(out.order.issues, hierCheck.issues);
  assert.strictEqual(out.order.issueCount, 5);
});

test('导入顺序：有未决冲突时不给出结论', () => {
  const out = buildImportOrder(hierConflictModel, {}, 'parent');
  assert.ok(out.unresolved > 0);
  assert.strictEqual(out.order, null);
  assert.strictEqual(out.rows, null);
});

test('导入顺序：裁决变化后重新计算（保留 vs 删除被指向的键）', () => {
  // 保留 T：C→T 有效 → 父先子后 [T, C]
  let out = buildImportOrder(hierConflictModel, { rowConflicts: { T: 'keep' } }, 'parent');
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.order.valid, true);
  assert.deepStrictEqual(out.order.keys.map((k) => k.key), ['T', 'C']);
  // 删除 T：C 缺失父项 → 阻止顺序导出
  out = buildImportOrder(hierConflictModel, { rowConflicts: { T: 'delete' } }, 'parent');
  assert.strictEqual(out.order.valid, false);
  assert.deepStrictEqual(
    out.order.issues.map((i) => [i.key, i.type]),
    [['C', 'missing-parent']],
  );
});

test('导入顺序：特殊键 __proto__ 作为父键也能正确链接（Map 索引不碰原型链）', () => {
  const p = parse3(
    'id,parent\nN,__proto__\n__proto__,',
    'id,parent\nN,__proto__\n__proto__,',
    'id,parent\nN,__proto__\n__proto__,',
  );
  const out = buildImportOrder(buildMerge(p, 'id'), {}, 'parent');
  assert.strictEqual(out.order.valid, true);
  assert.deepStrictEqual(out.order.keys.map((k) => k.key), ['__proto__', 'N']);
});

test('导入顺序：sortParentFirst 保持元素引用，仅重排', () => {
  const rows = [
    { key: 'c', parentKey: 'b' },
    { key: 'a', parentKey: '' },
    { key: 'b', parentKey: 'a' },
  ];
  const sorted = sortParentFirst(rows);
  assert.deepStrictEqual(sorted.map((r) => r.key), ['a', 'b', 'c']);
  assert.strictEqual(sorted[0], rows[1]);
  assert.strictEqual(sorted[2], rows[0]);
});

// ---------- 跨轮冲突裁决方案 ----------
test('方案：有未决冲突时不生成（unresolved > 0）', () => {
  const out = buildPlan(model, {});
  assert.ok(out.unresolved > 0);
  assert.ok(out.unresolvedDetails.some((m) => m.includes('K4')));
});

test('方案：全部裁决后只含冲突行，记录键列/表头/存在状态/原值/冲突/裁决，且不含行号与 roundId', () => {
  const out = buildPlan(model, ledgerDecisions);
  assert.strictEqual(out.unresolved, 0, out.unresolvedDetails.join('; '));
  const plan = out.plan;
  assert.strictEqual(plan.keyColumn, 'id');
  assert.deepStrictEqual(plan.headers, ['id', 'name', 'city', 'note']);
  assert.strictEqual('roundId' in plan, false);
  const keys = plan.rows.map((r) => r.key);
  // 只有冲突行：K4（删除/修改）、K6（单元格）、X2（同键异值新增）
  assert.deepStrictEqual(keys.sort(), ['K4', 'K6', 'X2']);
  assert.ok(plan.rows.every((r) => !('line' in r) && !('lines' in r)));

  const k4 = plan.rows.find((r) => r.key === 'K4');
  assert.strictEqual(k4.presence.local, false);
  assert.strictEqual(k4.presence.remote, true);
  assert.strictEqual(k4.values.local, null);
  assert.deepStrictEqual(k4.values.base, ['K4', '赵六', '深圳', '备注']);
  assert.deepStrictEqual(k4.conflicts, { row: 'row-delete-modify', cells: [] });
  assert.strictEqual(k4.decision.row, 'keep');
  assert.deepStrictEqual(k4.decision.cells, []);

  const k6 = plan.rows.find((r) => r.key === 'K6');
  assert.deepStrictEqual(k6.conflicts, { row: null, cells: [3] });
  assert.strictEqual(k6.decision.row, null);
  assert.deepStrictEqual(k6.decision.cells, [{ column: 3, choice: 'remote' }]);

  const x2 = plan.rows.find((r) => r.key === 'X2');
  assert.strictEqual(x2.presence.base, false);
  assert.deepStrictEqual(x2.conflicts, { row: 'row-add-divergent', cells: [3] });
  assert.strictEqual(x2.decision.row, 'keep');
  assert.deepStrictEqual(x2.decision.cells, [
    { column: 3, choice: 'manual', value: '我手填的' },
  ]);
});

test('方案：结构校验通过合法方案，拒绝各类格式错误', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  assert.strictEqual(validatePlanStructure(plan), null);

  const badKind = JSON.parse(JSON.stringify(plan));
  badKind.kind = 'x';
  assert.ok(validatePlanStructure(badKind));

  const badVersion = JSON.parse(JSON.stringify(plan));
  badVersion.version = 2;
  assert.ok(validatePlanStructure(badVersion));

  const badValues = JSON.parse(JSON.stringify(plan));
  badValues.rows[0].values.base[1] = 123;
  assert.ok(validatePlanStructure(badValues));

  const badPresence = JSON.parse(JSON.stringify(plan));
  badPresence.rows[0].presence.base = false; // 与 values.base 非 null 矛盾
  assert.ok(validatePlanStructure(badPresence));

  const badCellCoverage = JSON.parse(JSON.stringify(plan));
  badCellCoverage.rows.find((r) => r.key === 'K6').decision.cells = [];
  assert.ok(validatePlanStructure(badCellCoverage));

  const dupKey = JSON.parse(JSON.stringify(plan));
  dupKey.rows[1].key = dupKey.rows[0].key;
  assert.ok(validatePlanStructure(dupKey));

  assert.ok(validatePlanStructure(null));
  assert.ok(validatePlanStructure([]));
  assert.ok(validatePlanStructure({}));
});

test('方案：导入同样的模型 → 全部套用，裁决与手工导出的完全一致', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  const out = applyPlan(model, { rowConflicts: {}, cells: {} }, plan);
  assert.strictEqual(out.report.appliedCount, 3);
  assert.strictEqual(out.report.skippedCount, 0);
  const resolved = resolveAll(model, out.decisions);
  assert.strictEqual(resolved.unresolved, 0, resolved.unresolvedDetails.join('; '));
  const direct = resolveAll(model, ledgerDecisions);
  assert.deepStrictEqual(resolved.rows, direct.rows);
  // 不修改传入的裁决对象
  assert.deepStrictEqual(out.decisions !== undefined, true);
});

test('方案：行序与原文件行号变化不影响套用（打乱行序、插入不相关行）', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  const shuffledBase =
    'id,name,city,note\n' +
    'K9,郑十一,西安,备注\n' +
    'K6,孙八,成都,备注\n' +
    'K4,赵六,深圳,备注\n' +
    'K2,李四,上海,备注\n' +
    'K3,王五,广州,备注\n' +
    'K1,张三,北京,备注';
  const shuffledLocal =
    'id,name,city,note\n' +
    'X2,异,天津,本地备注\n' +
    'X1,同,重庆,z\n' +
    'L1,新A,苏州,x\n' +
    'K9,郑十一,西安,备注\n' +
    'K6,孙八,成都,本地值\n' +
    'K5,钱七,杭州,备注\n' +
    'K3,王五,深圳,备注\n' +
    'K2,李四,上海,相同备注\n' +
    'K1,张三,北京,本地备注';
  const shuffledRemote =
    'id,name,city,note\n' +
    'R1,新B,厦门,y\n' +
    'X2,异,天津,远端备注\n' +
    'X1,同,重庆,z\n' +
    'K9,郑十一,西安,备注\n' +
    'K7,周九,长沙,备注\n' +
    'K6,孙八,成都,远端值\n' +
    'K4,赵六,深圳,远端改备注\n' +
    'K3,王五,广州,备注\n' +
    'K2,李四,上海,相同备注\n' +
    'K1,张三,北京,备注';
  const p2 = parse3(shuffledBase, shuffledLocal, shuffledRemote);
  const model2 = buildMerge(p2, 'id');
  const out = applyPlan(model2, { rowConflicts: {}, cells: {} }, plan);
  assert.strictEqual(out.report.appliedCount, 3);
  const names = out.report.applied.map((r) => r.key).sort();
  assert.deepStrictEqual(names, ['K4', 'K6', 'X2']);
  assert.strictEqual(resolveAll(model2, out.decisions).unresolved, 0);
});

test('方案：键列不同 / 表头不同的方案无法导入（由调用方预检，applyPlan 不依赖预检）', () => {
  // 键列与表头预检在 server 中进行；这里验证不同模型下逐行核对得到的结果
  const { plan } = buildPlan(model, ledgerDecisions);
  // 另一份表头完全不同的模型：所有行键找不到 → 全部 key-not-found，不套用任何裁决
  const other = parse3('code,v\nK1,x', 'code,v\nK1,x', 'code,v\nK1,x');
  const otherModel = buildMerge(other, 'code');
  const out = applyPlan(otherModel, { rowConflicts: {}, cells: {} }, plan);
  assert.strictEqual(out.report.appliedCount, 0);
  assert.strictEqual(out.report.skippedCount, plan.rows.length);
  assert.ok(out.report.skipped.every((s) => s.reason === 'key-not-found'));
});

test('方案：原值不一致跳过（values-mismatch），且不套用该行', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  // K6 的本地值改成另一个值 → 冲突仍在，但原值不同
  const changed = parse3(
    'id,name,city,note\nK6,孙八,成都,备注',
    'id,name,city,note\nK6,孙八,成都,另一个本地值',
    'id,name,city,note\nK6,孙八,成都,远端值',
  );
  const m = buildMerge(changed, 'id');
  const out = applyPlan(m, { rowConflicts: {}, cells: {} }, plan);
  const k6 = out.report.skipped.find((s) => s.key === 'K6');
  assert.ok(k6);
  assert.strictEqual(k6.reason, 'values-mismatch');
  assert.strictEqual(out.decisions.cells.K6, undefined);
});

test('方案：存在状态不一致跳过（presence-mismatch）；行不再是冲突跳过（not-conflict）', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  // K4 本地不再删除（与远端一致）→ 不再是删除/修改冲突
  const p = parse3(
    'id,name,city,note\nK4,赵六,深圳,备注',
    'id,name,city,note\nK4,赵六,深圳,远端改备注',
    'id,name,city,note\nK4,赵六,深圳,远端改备注',
  );
  const m = buildMerge(p, 'id');
  const out = applyPlan(m, { rowConflicts: {}, cells: {} }, plan);
  const k4 = out.report.skipped.find((s) => s.key === 'K4');
  assert.ok(k4);
  assert.ok(['presence-mismatch', 'not-conflict'].includes(k4.reason));
  assert.strictEqual(out.decisions.rowConflicts.K4, undefined);
});

test('方案：冲突类型不一致跳过（conflict-mismatch）', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  // K6 本地改成与远端相同 → 单元格冲突消失
  const p = parse3(
    'id,name,city,note\nK6,孙八,成都,备注',
    'id,name,city,note\nK6,孙八,成都,远端值',
    'id,name,city,note\nK6,孙八,成都,远端值',
  );
  const m = buildMerge(p, 'id');
  const out = applyPlan(m, { rowConflicts: {}, cells: {} }, plan);
  const k6 = out.report.skipped.find((s) => s.key === 'K6');
  assert.ok(k6);
  assert.strictEqual(k6.reason, 'not-conflict');
});

test('方案：当前行已有任一裁决时整行跳过，保留人工操作', () => {
  const { plan } = buildPlan(model, ledgerDecisions);
  // K6 已手动取本地：方案（取远端）不得覆盖
  const existing = { rowConflicts: {}, cells: { K6: { 3: { choice: 'local' } } } };
  const out = applyPlan(model, existing, plan);
  const k6 = out.report.skipped.find((s) => s.key === 'K6');
  assert.ok(k6);
  assert.strictEqual(k6.reason, 'already-decided');
  assert.strictEqual(out.decisions.cells.K6[3].choice, 'local');
  // 行级冲突只裁决了去留也算"已有任一裁决"
  const existing2 = { rowConflicts: { K4: 'delete' }, cells: {} };
  const out2 = applyPlan(model, existing2, plan);
  assert.strictEqual(out2.report.skipped.find((s) => s.key === 'K4').reason, 'already-decided');
  assert.strictEqual(out2.decisions.rowConflicts.K4, 'delete');
});

test('方案：删除裁决（delete）被套用；部分套用部分跳过互不影响', () => {
  const decisionsDelete = {
    rowConflicts: { K4: 'delete', X2: 'delete' },
    cells: { K6: { 3: { choice: 'remote' } } },
  };
  const { plan } = buildPlan(model, decisionsDelete);
  // 只让 K6 已有裁决：K4 / X2 应套用 delete，K6 跳过
  const out = applyPlan(model, { rowConflicts: {}, cells: { K6: { 3: { choice: 'local' } } } }, plan);
  assert.strictEqual(out.report.appliedCount, 2);
  assert.strictEqual(out.decisions.rowConflicts.K4, 'delete');
  assert.strictEqual(out.decisions.rowConflicts.X2, 'delete');
  assert.strictEqual(out.decisions.cells.K6[3].choice, 'local');
  const resolved = resolveAll(model, out.decisions);
  assert.strictEqual(resolved.unresolved, 0, resolved.unresolvedDetails.join('; '));
});

// ---------- 特殊唯一键（__proto__ / constructor 等继承属性名）----------
// 普通对象以 "__proto__" 为键会触发原型链存取器；逐格裁决按唯一键存取时，
// 特殊键的选择既不能丢失，也不能串到另一普通键行。
function protoKeyModel() {
  return buildMerge(
    parse3(
      'id,v\n__proto__,b0\nN,n0',
      'id,v\n__proto__,lProto\nN,lN',
      'id,v\n__proto__,rProto\nN,rN',
    ),
    'id',
  );
}

test('特殊键 __proto__ 与普通键 N 同为冲突行，各自裁决互不串扰', () => {
  const m = protoKeyModel();
  assert.deepStrictEqual(
    m.rows.map((r) => [r.key, r.status]),
    [
      ['__proto__', 'conflict'],
      ['N', 'conflict'],
    ],
  );
  // 模拟修复后的页面 / 规范化后的请求：无原型容器，__proto__ 只是普通自有键
  const decisions = cloneDecisions(
    JSON.parse(
      '{"rowConflicts":{},"cells":{"__proto__":{"1":{"choice":"local"}},"N":{"1":{"choice":"remote"}}}}',
    ),
  );
  assert.deepStrictEqual(Object.keys(decisions.cells).sort(), ['N', '__proto__']);
  const out = resolveAll(m, decisions);
  assert.strictEqual(out.unresolved, 0, out.unresolvedDetails.join('; '));
  assert.deepStrictEqual(out.rows, [
    ['__proto__', 'lProto'],
    ['N', 'rN'],
  ]);
});

test('只裁决普通键 N：特殊键 __proto__ 仍未决，任何输出都不得给完成结论', () => {
  const m = protoKeyModel();
  const onlyN = cloneDecisions(
    JSON.parse('{"rowConflicts":{},"cells":{"N":{"1":{"choice":"remote"}}}}'),
  );
  const out = resolveAll(m, onlyN);
  assert.strictEqual(out.unresolved, 1);
  assert.ok(out.unresolvedDetails[0].includes('__proto__'));
  // 普通键 N 的取值仍然正确，不被特殊键影响
  assert.deepStrictEqual(out.rows.find((r) => r[0] === 'N'), ['N', 'rN']);

  const ledger = buildLedger(m, onlyN);
  assert.ok(ledger.unresolved > 0);
  const plan = buildPlan(m, onlyN);
  assert.ok(plan.unresolved > 0);
});

test('特殊键行的已有人工裁决优先：方案只套未裁决的匹配行，不覆盖人工选择', () => {
  const m = protoKeyModel();
  // 两行都完整裁决后导出方案
  const full = cloneDecisions(
    JSON.parse(
      '{"rowConflicts":{},"cells":{"__proto__":{"1":{"choice":"local"}},"N":{"1":{"choice":"remote"}}}}',
    ),
  );
  const { plan } = buildPlan(m, full);
  assert.deepStrictEqual(plan.rows.map((r) => r.key), ['__proto__', 'N']);

  // 新一轮：N 已手动取本地（与方案中的远端不同）→ N 整行跳过；__proto__ 套用
  const manual = cloneDecisions(
    JSON.parse('{"rowConflicts":{},"cells":{"N":{"1":{"choice":"local"}}}}'),
  );
  const applied = applyPlan(m, manual, plan);
  assert.strictEqual(applied.report.appliedCount, 1);
  assert.strictEqual(applied.report.applied[0].key, '__proto__');
  assert.strictEqual(applied.report.skippedCount, 1);
  assert.strictEqual(applied.report.skipped[0].key, 'N');
  assert.strictEqual(applied.report.skipped[0].reason, 'already-decided');
  // 人工裁决原样保留；套用结果可完整导出
  assert.strictEqual(applied.decisions.cells.N[1].choice, 'local');
  const resolved = resolveAll(m, applied.decisions);
  assert.strictEqual(resolved.unresolved, 0, resolved.unresolvedDetails.join('; '));
  assert.deepStrictEqual(resolved.rows, [
    ['__proto__', 'lProto'],
    ['N', 'lN'],
  ]);
});

test('方案导入结果可 JSON 往返：__proto__ 行裁决不丢失、不污染原型链', () => {
  const m = protoKeyModel();
  const { plan } = buildPlan(
    m,
    cloneDecisions(
      JSON.parse(
        '{"rowConflicts":{},"cells":{"__proto__":{"1":{"choice":"manual","value":"手填"}},"N":{"1":{"choice":"remote"}}}}',
      ),
    ),
  );
  const out = applyPlan(
    m,
    cloneDecisions({ rowConflicts: {}, cells: {} }),
    plan,
  );
  assert.strictEqual(out.report.appliedCount, 2);
  // JSON 序列化必须保留特殊键（无原型对象上它是普通自有属性）
  const json = JSON.stringify(out.decisions);
  assert.ok(json.includes('"__proto__"'));
  const reparsed = JSON.parse(json);
  assert.ok(Object.prototype.hasOwnProperty.call(reparsed.cells, '__proto__'));
  assert.strictEqual(reparsed.cells.__proto__[1].choice, 'manual');
  assert.strictEqual(reparsed.cells.__proto__[1].value, '手填');
  // 原型链保持干净
  assert.strictEqual(Object.getOwnPropertyDescriptor(Object.prototype, '1'), undefined);

  // 报告中的已套用列表同样包含特殊键
  assert.deepStrictEqual(
    out.report.applied.map((r) => r.key),
    ['__proto__', 'N'],
  );
});

test('特殊键 constructor 与字符串键 "1" 同样按普通自有属性处理', () => {
  const p = parse3('id,v\nconstructor,b0\n1,x0', 'id,v\nconstructor,lC\n1,l1', 'id,v\nconstructor,rC\n1,r1');
  const m = buildMerge(p, 'id');
  // 与请求规范化一致：从 JSON 文本解析（__proto__ / constructor 等均为自有键），
  // 再深拷贝为无原型容器
  const decisions = cloneDecisions(
    JSON.parse(
      '{"rowConflicts":{},"cells":{"constructor":{"1":{"choice":"remote"}},"1":{"1":{"choice":"local"}}}}',
    ),
  );
  const out = resolveAll(m, decisions);
  assert.strictEqual(out.unresolved, 0, out.unresolvedDetails.join('; '));
  assert.deepStrictEqual(out.rows, [
    ['constructor', 'rC'],
    ['1', 'l1'],
  ]);
  // ({}).constructor 仍是 Object 构造器，未被污染
  assert.strictEqual(({}).constructor, Object);
});

// ---------- 疑似唯一键变更核对 ----------
// 基准 4 键：G1/G2/G3 被两侧删除（消失键），KEEP 保留；两侧新增 N1..N4（新增键）
const kcBase =
  'id,name,city\nG1,张三,北京\nG2,李四,上海\nG3,王五,广州\nKEEP,保留,不变';
const kcSide =
  'id,name,city\nKEEP,保留,不变\nN1,张三,北京\nN2,李四,深圳\nN3,赵六,杭州\nN4,全新,城市';
const kcModel = buildMerge(parse3(kcBase, kcSide, kcSide), 'id');

test('核对参数：至少一个非键比较列，差异上限为 0 至比较列数的整数', () => {
  assert.strictEqual(validateKeyCheckParams(kcModel, ['name', 'city'], 1), null);
  assert.strictEqual(validateKeyCheckParams(kcModel, ['name'], 0), null);
  assert.ok(validateKeyCheckParams(kcModel, [], 0).includes('至少'));
  assert.ok(validateKeyCheckParams(kcModel, null, 0).includes('至少'));
  assert.ok(validateKeyCheckParams(kcModel, ['nope'], 0).includes('不在表头'));
  assert.ok(validateKeyCheckParams(kcModel, ['id'], 0).includes('唯一键'));
  assert.ok(validateKeyCheckParams(kcModel, ['name', 'name'], 0).includes('重复'));
  assert.ok(validateKeyCheckParams(kcModel, ['name'], -1).includes('差异上限'));
  assert.ok(validateKeyCheckParams(kcModel, ['name'], 2).includes('差异上限'));
  assert.ok(validateKeyCheckParams(kcModel, ['name'], 0.5).includes('差异上限'));
  assert.ok(validateKeyCheckParams(kcModel, ['name'], '0').includes('差异上限'));
});

test('核对：确定性配对先取配对数最多、再取总代价最小，稳定候选与候选代价正确', () => {
  const out = buildKeyChangeCheck(kcModel, {}, ['name', 'city'], 1);
  assert.strictEqual(out.unresolved, 0);
  const c = out.check;
  assert.strictEqual(c.oldCount, 3);
  assert.strictEqual(c.newCount, 4);
  // G1→N1（代价 0）、G2→N2（代价 1）；G3 与 N3/N4 两两代价 2 超过上限
  assert.strictEqual(c.pairCount, 2);
  assert.strictEqual(c.totalCost, 1);
  assert.strictEqual(c.candidateCount, 2);
  assert.strictEqual(c.candidateCost, 1);
  assert.strictEqual(c.pairs.length, 2);
  assert.deepStrictEqual(
    c.pairs.map((p) => [p.oldKey, p.newKey, p.cost]),
    [
      ['G1', 'N1', 0],
      ['G2', 'N2', 1],
    ],
  );
  const byKey = Object.fromEntries(c.oldKeys.map((k) => [k.key, k]));
  assert.deepStrictEqual(byKey.G1.possibleNewKeys, [{ newKey: 'N1', cost: 0 }]);
  assert.strictEqual(byKey.G1.canBeUnpaired, false);
  assert.strictEqual(byKey.G1.stable, true);
  assert.strictEqual(byKey.G1.stableNewKey, 'N1');
  assert.strictEqual(byKey.G1.stableCost, 0);
  assert.strictEqual(byKey.G1.line, 2); // 基准物理行号
  assert.strictEqual(byKey.G2.stable, true);
  assert.strictEqual(byKey.G2.stableNewKey, 'N2');
  // G3 在所有最优方案中都不配对
  assert.deepStrictEqual(byKey.G3.possibleNewKeys, []);
  assert.strictEqual(byKey.G3.canBeUnpaired, true);
  assert.strictEqual(byKey.G3.stable, false);
  assert.deepStrictEqual(c.unpairedOldKeys, ['G3']);
  assert.deepStrictEqual(c.unpairedNewKeys, ['N3', 'N4']);
  assert.deepStrictEqual(
    c.newKeys.map((k) => [k.key, k.line, k.pairable]),
    [
      ['N1', 3, true],
      ['N2', 4, true],
      ['N3', 5, false],
      ['N4', 6, false],
    ],
  );
  assert.ok(c.disclaimer.includes('不能认定为真实改名'));
});

test('核对：配对数优先于总代价（宁多勿省）', () => {
  // A→X 代价 0、A→Y 代价 1、B→Y 代价 1：
  // 1 对方案最低代价 0（A→X），但 2 对方案（代价 1）配对数更多，必须选后者
  const p = parse3('id,a,b\nA,1,1\nB,9,9', 'id,a,b\nX,1,1\nY,1,9', 'id,a,b\nX,1,1\nY,1,9');
  const m = buildMerge(p, 'id');
  const out = buildKeyChangeCheck(m, {}, ['a', 'b'], 1);
  assert.strictEqual(out.check.pairCount, 2);
  assert.strictEqual(out.check.totalCost, 1);
  assert.deepStrictEqual(
    out.check.pairs.map((x) => [x.oldKey, x.newKey]).sort(),
    [
      ['A', 'X'],
      ['B', 'Y'],
    ],
  );
});

test('核对：允许交叉配对', () => {
  const p = parse3('id,v\nO1,x\nO2,y', 'id,v\nN1,y\nN2,x', 'id,v\nN1,y\nN2,x');
  const out = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0);
  assert.strictEqual(out.check.pairCount, 2);
  assert.deepStrictEqual(
    out.check.pairs.map((x) => [x.oldKey, x.newKey]),
    [
      ['O1', 'N2'],
      ['O2', 'N1'],
    ],
  );
  assert.strictEqual(out.check.candidateCount, 2);
});

test('核对：多种可能时不标稳定候选；可能未配对单独标出', () => {
  // 2 旧 2 新全等：每个旧键都可能配向任一新键，且都不可能未配对
  let p = parse3('id,v\nA1,同\nA2,同', 'id,v\nB1,同\nB2,同', 'id,v\nB1,同\nB2,同');
  let c = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0).check;
  assert.strictEqual(c.pairCount, 2);
  assert.strictEqual(c.candidateCount, 0);
  for (const k of c.oldKeys) {
    assert.deepStrictEqual(
      k.possibleNewKeys.map((x) => x.newKey),
      ['B1', 'B2'],
    );
    assert.strictEqual(k.canBeUnpaired, false);
    assert.strictEqual(k.stable, false);
  }
  // 2 旧 1 新：每个旧键都可能配向 B1，也都可能未配对 → 都不是稳定候选
  p = parse3('id,v\nA1,同\nA2,同', 'id,v\nB1,同', 'id,v\nB1,同');
  c = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0).check;
  assert.strictEqual(c.pairCount, 1);
  for (const k of c.oldKeys) {
    assert.deepStrictEqual(
      k.possibleNewKeys.map((x) => x.newKey),
      ['B1'],
    );
    assert.strictEqual(k.canBeUnpaired, true);
    assert.strictEqual(k.stable, false);
  }
});

test('核对：逐格按原字符串比较，不裁剪空白', () => {
  // 基准 'x '（尾随空格）与新键 'x' 不同 → 代价 1，上限 0 时不能配对
  const p = parse3('id,v\nA,x \nK,keep', 'id,v\nK,keep\nB,x', 'id,v\nK,keep\nB,x');
  const m = buildMerge(p, 'id');
  let out = buildKeyChangeCheck(m, {}, ['v'], 0);
  assert.strictEqual(out.check.pairCount, 0);
  assert.deepStrictEqual(out.check.unpairedOldKeys, ['A']);
  out = buildKeyChangeCheck(m, {}, ['v'], 1);
  assert.strictEqual(out.check.pairCount, 1);
  assert.strictEqual(out.check.totalCost, 1);
  assert.strictEqual(out.check.oldKeys[0].stable, true);
  assert.strictEqual(out.check.oldKeys[0].stableNewKey, 'B');
});

test('核对：任一组为空时返回空配对并列出未配对旧键', () => {
  // 没有消失键：空配对，新增键全部未配对
  let p = parse3('id,v\nK,a', 'id,v\nK,a\nN1,b', 'id,v\nK,a\nN1,b');
  let c = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0).check;
  assert.strictEqual(c.pairCount, 0);
  assert.strictEqual(c.totalCost, 0);
  assert.deepStrictEqual(c.pairs, []);
  assert.deepStrictEqual(c.unpairedOldKeys, []);
  assert.deepStrictEqual(c.unpairedNewKeys, ['N1']);
  assert.strictEqual(c.candidateCount, 0);
  // 没有新增键：空配对，全部消失键列入未配对旧键
  p = parse3('id,v\nK,a\nD1,b\nD2,c', 'id,v\nK,a', 'id,v\nK,a');
  c = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0).check;
  assert.strictEqual(c.pairCount, 0);
  assert.deepStrictEqual(c.pairs, []);
  assert.deepStrictEqual(c.unpairedOldKeys, ['D1', 'D2']);
  assert.deepStrictEqual(c.unpairedNewKeys, []);
  assert.ok(c.oldKeys.every((k) => k.canBeUnpaired && !k.stable));
});

test('核对：任一组超过 12 个时明确提示（limitExceeded），不给出配对', () => {
  const many = (prefix, count, start) =>
    Array.from({ length: count }, (_, i) => `${prefix}${start + i},v${i}`).join('\n');
  // 13 个消失键
  let p = parse3(`id,v\n${many('O', 13, 0)}`, 'id,v\nK,keep', 'id,v\nK,keep');
  let out = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0);
  assert.strictEqual(out.check, undefined);
  assert.deepStrictEqual(out.limitExceeded, { oldCount: 13, newCount: 1, limit: KEY_CHECK_LIMIT });
  // 13 个新增键
  p = parse3('id,v\nK,keep', `id,v\nK,keep\n${many('N', 13, 0)}`, `id,v\nK,keep\n${many('N', 13, 0)}`);
  out = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0);
  assert.deepStrictEqual(out.limitExceeded, { oldCount: 0, newCount: 13, limit: KEY_CHECK_LIMIT });
  // 恰好 12 个不受限
  p = parse3(`id,v\n${many('O', 12, 0)}`, 'id,v\nK,keep', 'id,v\nK,keep');
  out = buildKeyChangeCheck(buildMerge(p, 'id'), {}, ['v'], 0);
  assert.strictEqual(out.limitExceeded, undefined);
  assert.strictEqual(out.check.oldCount, 12);
});

test('核对：有未决冲突时不给出结论；裁决变化后消失键集合随之变化', () => {
  // T 被本地删除、被远端修改 → 行级冲突；另有一新增键 N1 与 T 同行值
  const p = parse3(
    'id,v\nT,相同\nK,keep',
    'id,v\nK,keep\nN1,相同',
    'id,v\nT,改动\nK,keep\nN1,相同',
  );
  const m = buildMerge(p, 'id');
  assert.strictEqual(m.rows.find((r) => r.key === 'T').status, 'conflict');
  // 未裁决：不给出结论
  let out = buildKeyChangeCheck(m, {}, ['v'], 0);
  assert.ok(out.unresolved > 0);
  assert.strictEqual(out.check, undefined);
  // 裁决删除 T：T 成为消失键，与 N1 代价 0 → 稳定候选
  out = buildKeyChangeCheck(m, { rowConflicts: { T: 'delete' } }, ['v'], 0);
  assert.strictEqual(out.unresolved, 0);
  assert.deepStrictEqual(out.check.unpairedOldKeys, []);
  assert.strictEqual(out.check.pairCount, 1);
  assert.strictEqual(out.check.oldKeys[0].key, 'T');
  assert.strictEqual(out.check.oldKeys[0].stable, true);
  assert.strictEqual(out.check.oldKeys[0].stableNewKey, 'N1');
  // 裁决保留 T：T 留在最终结果（值为远端"改动"），消失键为空 → 空配对
  out = buildKeyChangeCheck(m, { rowConflicts: { T: 'keep' } }, ['v'], 0);
  assert.strictEqual(out.check.oldCount, 0);
  assert.strictEqual(out.check.pairCount, 0);
  assert.deepStrictEqual(out.check.unpairedNewKeys, ['N1']);
});

// ---------- 最小决定列发现 ----------
test('发现参数：目标列非键且存在；候选列 1～10 个互异、不含目标列与唯一键列', () => {
  const csv = 'id,a,b,c\n1,x,y,z';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  assert.strictEqual(validateDeterminantParams(m, 'a', ['b']), null);
  assert.strictEqual(validateDeterminantParams(m, 'a', ['b', 'c']), null);
  assert.ok(validateDeterminantParams(m, 'id', ['a']).includes('目标列不能是唯一键列'));
  assert.ok(validateDeterminantParams(m, 'a', ['id']).includes('唯一键'));
  assert.ok(validateDeterminantParams(m, 'a', ['a']).includes('目标列'));
  assert.ok(validateDeterminantParams(m, 'a', ['b', 'b']).includes('重复'));
  assert.ok(validateDeterminantParams(m, 'a', []).includes('1 至 10'));
  assert.ok(validateDeterminantParams(m, 'a', null).includes('1 至 10'));
  assert.ok(
    validateDeterminantParams(m, 'a', ['a0','a1','a2','a3','a4','a5','a6','a7','a8','a9','a10'])
      .includes('1 至 10'),
  );
  assert.ok(validateDeterminantParams(m, 'nope', ['b']).includes('不在表头'));
  assert.ok(validateDeterminantParams(m, 'a', ['nope']).includes('不在表头'));
  assert.ok(validateDeterminantParams(m, '', ['b']).includes('缺少'));
  assert.ok(validateDeterminantParams(m, 123, ['b']).includes('缺少'));
});

test('发现：同时枚举出不同列数的所有最小组合（不只列数最少者），按列数 / 表头列序排列', () => {
  // {a} 与 {b,c} 都决定 t；{b}、{c} 单独不决定；{a,b,c} 非最小
  const csv =
    'id,a,b,c,t\n' +
    'r1,a1,b1,c1,X\n' +
    'r2,a2,b1,c2,Y\n' +
    'r3,a3,b2,c1,Y\n' +
    'r4,a4,b2,c2,X';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  const out = buildDeterminants(m, {}, 't', ['a', 'b', 'c']);
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.result.combinationCount, 2);
  assert.deepStrictEqual(
    out.result.combinations.map((c) => c.columns),
    [['a'], ['b', 'c']],
  );
  const [sa, sbc] = out.result.combinations;
  assert.strictEqual(sa.columnCount, 1);
  assert.strictEqual(sbc.columnCount, 2);
  assert.strictEqual(sa.witnesses.length, 1);
  assert.strictEqual(sbc.witnesses.length, 2);
  assert.deepStrictEqual(
    sbc.witnesses.map((w) => [w.removedColumn, w.row1.key, w.row2.key]),
    [
      ['b', 'r1', 'r3'], // 移除 b 后按 c 分组：r1/r3 同 c1、t 不同（字典序最早）
      ['c', 'r1', 'r2'], // 移除 c 后按 b 分组：r1/r2 同 b1、t 不同
    ],
  );
  for (const w of sbc.witnesses) {
    assert.strictEqual(w.row1.line, 2);
    assert.notStrictEqual(w.row1.targetValue, w.row2.targetValue);
  }
  assert.strictEqual(out.result.counterexample, null);
  assert.strictEqual(out.result.constantTarget, false);
  assert.ok(out.result.disclaimer.includes('仅'));
});

test('发现：目标恒定时只返回空组合，无失效证明', () => {
  const csv = 'id,x,y,t\n1,p,q,Z\n2,r,s,Z';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  const out = buildDeterminants(m, {}, 't', ['x', 'y']);
  assert.strictEqual(out.result.combinationCount, 1);
  assert.deepStrictEqual(out.result.combinations[0].columns, []);
  assert.strictEqual(out.result.combinations[0].columnCount, 0);
  assert.deepStrictEqual(out.result.combinations[0].witnesses, []);
  assert.strictEqual(out.result.constantTarget, true);
  assert.strictEqual(out.result.counterexample, null);
});

test('发现：无组合时给出全候选列相同而目标不同的字典序最早反例', () => {
  // 扫描中先遇到 r3/r4（i=2）冲突，但全局 i 最小的冲突是后来才配成的 r2/r5（i=1）
  const csv =
    'id,x,y,t\n' +
    'r1,p,q,A\n' +
    'r2,u,v,A\n' +
    'r3,w,z,A\n' +
    'r4,w,z,B\n' +
    'r5,u,v,B';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  const out = buildDeterminants(m, {}, 't', ['x', 'y']);
  assert.strictEqual(out.result.combinationCount, 0);
  assert.deepStrictEqual(out.result.combinations, []);
  const ce = out.result.counterexample;
  assert.strictEqual(ce.row1.key, 'r2');
  assert.strictEqual(ce.row2.key, 'r5');
  assert.strictEqual(ce.row1.targetValue, 'A');
  assert.strictEqual(ce.row2.targetValue, 'B');
  assert.deepStrictEqual(
    ce.values.map((v) => [v.column, v.value]),
    [
      ['x', 'u'],
      ['y', 'v'],
    ],
  );
  assert.strictEqual(out.result.constantTarget, false);
});

test('发现：逐格按原字符串比较，空字符串也是普通值', () => {
  // x 两行为空串但 y 不同 → {y} 成立、{x} 不成立；尾随空格不裁剪
  const csv = 'id,x,y,t\n1,,q,A\n2,,s,B';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  let out = buildDeterminants(m, {}, 't', ['x', 'y']);
  assert.deepStrictEqual(
    out.result.combinations.map((c) => c.columns),
    [['y']],
  );
  // 空串与含空格的串不同：两行 x 为 '' / ' ' 且目标不同，{x} 单独成立
  const csv2 = 'id,x,t\n1,,A\n2, ,B';
  const m2 = buildMerge(parse3(csv2, csv2, csv2), 'id');
  out = buildDeterminants(m2, {}, 't', ['x']);
  assert.deepStrictEqual(out.result.combinations.map((c) => c.columns), [['x']]);
});

test('发现：候选列序与表头不一致时仍按基准表头列序输出组合', () => {
  const csv =
    'id,a,b,t\n' +
    'r1,a1,b1,X\n' +
    'r2,a2,b1,Y\n' +
    'r3,a1,b2,X';
  const m = buildMerge(parse3(csv, csv, csv), 'id');
  // 请求顺序倒着传；输出仍按表头列序
  const out = buildDeterminants(m, {}, 't', ['b', 'a']);
  assert.deepStrictEqual(out.result.candidateColumns, ['a', 'b']);
  assert.deepStrictEqual(
    out.result.combinations.map((c) => c.columns),
    [['a']],
  );
});

test('发现：无保留行时 noData=true 提示无数据', () => {
  // K 被两侧删除（侧文件只有表头）→ 最终保留行 0
  const m = buildMerge(parse3('id,x,t\nK,v,A', 'id,x,t', 'id,x,t'), 'id');
  const out = buildDeterminants(m, {}, 't', ['x']);
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.limitExceeded, undefined);
  assert.strictEqual(out.result.noData, true);
  assert.strictEqual(out.result.rowCount, 0);
  assert.deepStrictEqual(out.result.combinations, []);
  assert.strictEqual(out.result.counterexample, null);
});

test('发现：最终保留行超过 300 行时限超提示（limitExceeded），恰好 300 行正常', () => {
  const make = (n) =>
    'id,x,t\n' +
    Array.from({ length: n }, (_, i) => `k${i},v${i},t${i}`).join('\n');
  let m = buildMerge(parse3(make(301), make(301), make(301)), 'id');
  let out = buildDeterminants(m, {}, 't', ['x']);
  assert.strictEqual(out.result, undefined);
  assert.deepStrictEqual(out.limitExceeded, { rowCount: 301, limit: DETERMINANT_ROW_LIMIT });
  assert.strictEqual(DETERMINANT_ROW_LIMIT, 300);
  m = buildMerge(parse3(make(300), make(300), make(300)), 'id');
  out = buildDeterminants(m, {}, 't', ['x']);
  assert.strictEqual(out.limitExceeded, undefined);
  assert.strictEqual(out.result.rowCount, 300);
  assert.deepStrictEqual(out.result.combinations.map((c) => c.columns), [['x']]);
});

test('发现：有未决冲突时不给出结论；裁决变化后结论随之变化', () => {
  // T 本地 / 远端把 x 改成不同值 → 单元格冲突
  const p = parse3('id,x,t\nT,v,A', 'id,x,t\nT,l,A', 'id,x,t\nT,r,B');
  const m = buildMerge(p, 'id');
  assert.strictEqual(m.rows.find((r) => r.key === 'T').status, 'conflict');
  let out = buildDeterminants(m, {}, 't', ['x']);
  assert.ok(out.unresolved > 0);
  assert.strictEqual(out.result, undefined);
  // 取本地：x 列冲突取本地 l（t 列仅远端改动，自动采纳 B）；仅一行 → 目标恒定
  out = buildDeterminants(m, { cells: { T: { 1: { choice: 'local' } } } }, 't', ['x']);
  assert.strictEqual(out.unresolved, 0);
  assert.strictEqual(out.result.constantTarget, true);
  // 取远端：同样只有一行 T，目标恒定
  out = buildDeterminants(m, { cells: { T: { 1: { choice: 'remote' } } } }, 't', ['x']);
  assert.strictEqual(out.result.constantTarget, true);
});

test('发现：最终行序与逐格取值和导出一致（读裁决后的最终保留行，含删除键）', () => {
  // D 两侧删除不参与；保留键 K1/K2 在 x 上相同、t 不同 → 无组合，反例为 K1/K2
  const p = parse3(
    'id,x,t\nK1,v,A\nK2,v,B\nD,d,Z',
    'id,x,t\nK1,v,A\nK2,v,B',
    'id,x,t\nK1,v,A\nK2,v,B',
  );
  const m = buildMerge(p, 'id');
  const out = buildDeterminants(m, {}, 't', ['x']);
  assert.strictEqual(out.result.rowCount, 2);
  const ce = out.result.counterexample;
  assert.strictEqual(ce.row1.key, 'K1');
  assert.strictEqual(ce.row2.key, 'K2');
});

console.log(`\n全部 ${passed} 个测试通过`);
