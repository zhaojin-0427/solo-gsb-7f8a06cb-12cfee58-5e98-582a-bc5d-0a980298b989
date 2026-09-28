'use strict';
// 端到端 HTTP 测试：本轮标识（roundId）驱动的上传 / 合并 / 导出流程。
// 重点：大文件不再随合并、导出请求重传；标识无效 / 过期明确报错且不串轮。
const assert = require('assert');
const http = require('http');
const { start } = require('../server');
const { RoundStore } = require('../src/rounds');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

const server = start();
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        headers: {
          ...(data ? { 'Content-Length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function jsonReq(urlPath, payload) {
  const body = JSON.stringify(payload);
  return request('POST', urlPath, {
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function multipartBody(files) {
  const boundary = '----nodeBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, { filename, content }] of Object.entries(files)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: text/csv\r\n\r\n`,
    ));
    parts.push(Buffer.from(content, 'utf8'));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(files) {
  const mp = multipartBody(files);
  return request('POST', '/api/upload', {
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
  });
}

const SMALL = {
  base: {
    filename: 'base.csv',
    content: 'id,name,city\nK1,张三,北京\nK2,李四,上海\nK3,王五,广州',
  },
  local: {
    filename: 'local.csv',
    // K1 本地改城市；K3 本地删除
    content: 'id,name,city\nK1,张三,深圳\nK2,李四,上海',
  },
  remote: {
    filename: 'remote.csv',
    // K1 远端改成另一个值（单元格冲突）；K3 远端未动
    content: 'id,name,city\nK1,张三,杭州\nK2,李四,上海\nK3,王五,广州',
  },
};

(async () => {
  try {
    // ---------- 基础流程 ----------
    await test('健康检查', async () => {
      const r = await request('GET', '/api/health');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json(), { ok: true });
    });

    await test('上传成功返回 roundId，且响应不再携带完整 parsed', async () => {
      const r = await upload(SMALL);
      assert.strictEqual(r.status, 200, r.text);
      const data = r.json();
      assert.strictEqual(data.ok, true);
      assert.ok(typeof data.roundId === 'string' && data.roundId.length >= 32);
      assert.deepStrictEqual(data.headers, ['id', 'name', 'city']);
      assert.strictEqual(data.files.base.rowCount, 3);
      assert.strictEqual(data.parsed, undefined);
    });

    const roundId = (await upload(SMALL)).json().roundId;

    await test('合并只传 roundId + keyColumn', async () => {
      const r = await jsonReq('/api/merge', { roundId, keyColumn: 'id' });
      assert.strictEqual(r.status, 200, r.text);
      const data = r.json();
      assert.strictEqual(data.ok, true);
      const byKey = Object.fromEntries(data.model.rows.map((x) => [x.key, x]));
      assert.strictEqual(byKey.K1.status, 'conflict'); // 本地深圳 vs 远端杭州
      assert.strictEqual(byKey.K3.status, 'deleted'); // 本地删除、远端未动
    });

    await test('未解决冲突导出 → 409', async () => {
      const r = await jsonReq('/api/export', { roundId, decisions: {} });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
    });

    let csvText = '';
    await test('冲突裁决后导出 CSV（K1 手填，K3 删除生效）', async () => {
      const r = await jsonReq('/api/export', {
        roundId,
        decisions: {
          rowConflicts: {},
          cells: { K1: { 2: { choice: 'manual', value: '最终城市' } } },
        },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(r.headers['content-type'].includes('text/csv'));
      csvText = r.text;
      assert.ok(csvText.charCodeAt(0) === 0xfeff, '导出带 UTF-8 BOM');
      assert.ok(csvText.includes('K1,张三,最终城市'));
      assert.ok(!csvText.includes('K3,'), 'K3 应被删除');
    });

    // ---------- 来源账本 ----------
    const ledgerDecisions = {
      rowConflicts: {},
      cells: { K1: { 2: { choice: 'manual', value: '最终城市' } } },
    };

    await test('未解决冲突时请求账本 → 409，拒绝生成完整账本', async () => {
      const r = await jsonReq('/api/ledger', { roundId, decisions: {} });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
    });

    let ledger = null;
    await test('裁决后生成账本：逐格来源与行号正确，删除键单独列出', async () => {
      const r = await jsonReq('/api/ledger', { roundId, decisions: ledgerDecisions });
      assert.strictEqual(r.status, 200, r.text);
      ledger = r.json().ledger;
      assert.ok(ledger);
      assert.deepStrictEqual(ledger.headers, ['id', 'name', 'city']);
      // 行序与最终 CSV 一致（K3 删除，不混入输出行）
      assert.deepStrictEqual(ledger.rows.map((x) => x.key), ['K1', 'K2']);
      // K1：手填记人工且不虚构行号；未改列记基准并带基准行号
      const k1 = ledger.rows[0];
      assert.strictEqual(k1.cells[2].value, '最终城市');
      assert.strictEqual(k1.cells[2].source, 'manual');
      assert.strictEqual(k1.cells[2].lines, null);
      assert.strictEqual(k1.cells[1].source, 'base');
      assert.deepStrictEqual(k1.cells[1].lines, { base: 2 });
      // K2：三方一致，全记基准
      assert.ok(ledger.rows[1].cells.every((c) => c.source === 'base'));
      // K3：本地删除、远端未动 → 单独列出删除原因
      assert.strictEqual(ledger.deleted.length, 1);
      assert.strictEqual(ledger.deleted[0].key, 'K3');
      assert.strictEqual(ledger.deleted[0].reason, 'local-deleted');
      assert.deepStrictEqual(ledger.deleted[0].lines, { base: 4, remote: 4 });
    });

    await test('账本逐格取值与 CSV 导出一致', async () => {
      const ex = await jsonReq('/api/export', { roundId, decisions: ledgerDecisions });
      assert.strictEqual(ex.status, 200, ex.text);
      const csvRows = ex.text
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(1)
        .map((line) => line.split(','));
      assert.strictEqual(ledger.rows.length, csvRows.length);
      ledger.rows.forEach((lrow, i) => {
        assert.deepStrictEqual(
          lrow.cells.map((c) => c.value),
          csvRows[i],
          `键 ${lrow.key} 账本取值与 CSV 导出不一致`,
        );
      });
    });

    await test('账本只按服务端本轮模型与裁决计算，无视浏览器回传的行数据', async () => {
      const r = await jsonReq('/api/ledger', {
        roundId,
        decisions: ledgerDecisions,
        // 伪造的行数据 / 模型：服务端必须忽略
        rows: [['HACK', 'x', 'y']],
        model: { headers: ['a'], rows: [] },
        ledger: { rows: [] },
      });
      assert.strictEqual(r.status, 200, r.text);
      const lg = r.json().ledger;
      assert.deepStrictEqual(lg.rows.map((x) => x.key), ['K1', 'K2']);
      assert.ok(!lg.rows.some((x) => x.key === 'HACK'));
    });

    await test('账本使用不存在的 roundId → 404', async () => {
      const r = await jsonReq('/api/ledger', { roundId: 'nope', decisions: {} });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
    });

    await test('有效轮次但尚未合并就请求账本 → 400', async () => {
      const fresh = (await upload(SMALL)).json().roundId;
      const r = await jsonReq('/api/ledger', { roundId: fresh, decisions: {} });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
    });

    // ---------- 父子层级核验 ----------
    // A 根；B→A→C 正常；D 指向不存在的 X；E 自环；F↔G 成环；H 仅指向环；
    // I 指向将被本地删除的 DEL
    const HIER = {
      base: {
        filename: 'base.csv',
        content:
          'id,parent,name\n' +
          'A,,根\nB,A,子\nC,B,孙\nD,X,缺失\nE,E,自环\n' +
          'F,G,环一\nG,F,环二\nH,F,指向环\nI,DEL,指向删除\nDEL,,将被删除',
      },
      local: {
        filename: 'local.csv',
        content:
          'id,parent,name\n' +
          'A,,根\nB,A,子\nC,B,孙\nD,X,缺失\nE,E,自环\nF,G,环一\nG,F,环二\nH,F,指向环\nI,DEL,指向删除',
      },
      remote: {
        filename: 'remote.csv',
        content:
          'id,parent,name\n' +
          'A,,根\nB,A,子\nC,B,孙\nD,X,缺失\nE,E,自环\n' +
          'F,G,环一\nG,F,环二\nH,F,指向环\nI,DEL,指向删除\nDEL,,将被删除',
      },
    };
    const hierRound = (await upload(HIER)).json().roundId;
    const hierMerge = await jsonReq('/api/merge', { roundId: hierRound, keyColumn: 'id' });
    assert.strictEqual(hierMerge.status, 200, hierMerge.text);

    await test('层级核验：缺少 parentColumn → 400', async () => {
      const r = await jsonReq('/api/hierarchy', { roundId: hierRound, decisions: {} });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
      assert.ok(r.json().errors[0].message.includes('parentColumn'));
    });

    await test('层级核验：父键列与唯一键列相同 → 400', async () => {
      const r = await jsonReq('/api/hierarchy', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'id',
      });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json().errors[0].message.includes('唯一键'));
    });

    await test('层级核验：父键列不在表头中 → 400', async () => {
      const r = await jsonReq('/api/hierarchy', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'nope',
      });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json().errors[0].message.includes('不在表头'));
    });

    await test('层级核验：不存在的 roundId → 404 且提示重新上传', async () => {
      const r = await jsonReq('/api/hierarchy', {
        roundId: 'nope',
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
      assert.ok(r.json().errors[0].message.includes('重新上传'));
    });

    await test('层级核验：有效轮次但尚未合并 → 400', async () => {
      const fresh = (await upload(HIER)).json().roundId;
      const r = await jsonReq('/api/hierarchy', {
        roundId: fresh,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
    });

    await test('层级核验：有未决冲突 → 409，不给出完整结论', async () => {
      // SMALL 这一轮还有 K1 的单元格冲突未裁决
      const r = await jsonReq('/api/hierarchy', {
        roundId,
        decisions: {},
        parentColumn: 'city',
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
      assert.strictEqual(r.json().check, undefined);
    });

    let hierCheck = null;
    await test('层级核验：按最终保留行报告缺失父项与循环，行序与输出行号正确', async () => {
      const r = await jsonReq('/api/hierarchy', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 200, r.text);
      hierCheck = r.json().check;
      assert.ok(hierCheck);
      assert.strictEqual(hierCheck.keyColumn, 'id');
      assert.strictEqual(hierCheck.parentColumn, 'parent');
      assert.strictEqual(hierCheck.rowCount, 9); // DEL 被本地删除
      assert.strictEqual(hierCheck.issueCount, 5);
      assert.deepStrictEqual(
        hierCheck.issues.map((i) => [i.key, i.type, i.line]),
        [
          ['D', 'missing-parent', 5],
          ['E', 'cycle', 6],
          ['F', 'cycle', 7],
          ['G', 'cycle', 8],
          ['I', 'missing-parent', 10],
        ],
      );
      // 指向环的非环成员不报循环
      assert.ok(!hierCheck.issues.some((i) => i.key === 'H'));
      // 每条问题都带父键与中文类型说明
      for (const it of hierCheck.issues) {
        assert.ok(typeof it.parentKey === 'string');
        assert.ok(it.typeText.length > 0);
      }
    });

    await test('层级核验：只按服务端模型与裁决计算，无视夹带数据，且不影响 CSV 导出', async () => {
      const r = await jsonReq('/api/hierarchy', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'parent',
        // 伪造的行数据 / 结果：服务端必须忽略
        rows: [['HACK', '', 'x']],
        model: { headers: ['a'], rows: [] },
        check: { issues: [] },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json().check.issues, hierCheck.issues);
      assert.ok(!r.json().check.issues.some((i) => i.key === 'HACK'));

      // 核验只提示：导出内容与行数不受任何影响
      const ex = await jsonReq('/api/export', { roundId: hierRound, decisions: {} });
      assert.strictEqual(ex.status, 200, ex.text);
      const outLines = ex.text.split(/\r?\n/).filter(Boolean);
      assert.strictEqual(outLines.length, 10); // 表头 + 9 行保留数据
      // 键为 DEL 的行应被删除（不能只查子串 "DEL,"，那会误匹配 "I,DEL,指向删除" 的父键值）
      assert.ok(!outLines.some((l) => l.startsWith('DEL,')), 'DEL 应被删除');
    });

    // ---------- 父子数据导入顺序 ----------
    // 三方一致（无冲突）：C1 在原行序中早于其父 R1，G1 是 C1 的子行
    const ORD_CSV =
      'id,parent,name\nR2,,根二\nC1,R1,子一\nR1,,根一\nC2,R1,子二\nG1,C1,孙一';
    const ORD = {
      base: { filename: 'base.csv', content: ORD_CSV },
      local: { filename: 'local.csv', content: ORD_CSV },
      remote: { filename: 'remote.csv', content: ORD_CSV },
    };
    const ordRound = (await upload(ORD)).json().roundId;
    assert.strictEqual(
      (await jsonReq('/api/merge', { roundId: ordRound, keyColumn: 'id' })).status,
      200,
    );

    await test('导入顺序：roundId 无效 → 404；尚未合并 → 400；父键列非法 → 400', async () => {
      let r = await jsonReq('/api/order', { roundId: 'nope', decisions: {}, parentColumn: 'parent' });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
      r = await jsonReq('/api/order/export', {
        roundId: 'nope',
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 404);

      const fresh = (await upload(ORD)).json().roundId;
      r = await jsonReq('/api/order', { roundId: fresh, decisions: {}, parentColumn: 'parent' });
      assert.strictEqual(r.status, 400);
      r = await jsonReq('/api/order/export', {
        roundId: fresh,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 400);

      r = await jsonReq('/api/order', { roundId: ordRound, decisions: {} });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json().errors[0].message.includes('parentColumn'));
      r = await jsonReq('/api/order', { roundId: ordRound, decisions: {}, parentColumn: 'id' });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json().errors[0].message.includes('唯一键'));
      r = await jsonReq('/api/order/export', {
        roundId: ordRound,
        decisions: {},
        parentColumn: 'nope',
      });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json().errors[0].message.includes('不在表头'));
    });

    await test('导入顺序：有未决冲突 → 409（两个接口一致）', async () => {
      // SMALL 这一轮还有 K1 的单元格冲突未裁决
      let r = await jsonReq('/api/order', { roundId, decisions: {}, parentColumn: 'city' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
      r = await jsonReq('/api/order/export', { roundId, decisions: {}, parentColumn: 'city' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
    });

    await test('导入顺序：有效层级返回父先子后键序（每步取原行序最早的可输出行）', async () => {
      const r = await jsonReq('/api/order', {
        roundId: ordRound,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 200, r.text);
      const order = r.json().order;
      assert.strictEqual(order.valid, true);
      assert.strictEqual(order.issueCount, 0);
      assert.strictEqual(order.rowCount, 5);
      assert.deepStrictEqual(
        order.keys.map((k) => k.key),
        ['R2', 'R1', 'C1', 'C2', 'G1'],
      );
      assert.deepStrictEqual(
        order.keys.map((k) => k.mergedLine),
        [2, 4, 3, 5, 6],
      );
      assert.deepStrictEqual(
        order.keys.map((k) => k.line),
        [2, 3, 4, 5, 6],
      );
      assert.deepStrictEqual(
        order.keys.map((k) => k.parentKey),
        ['', '', 'R1', 'R1', 'C1'],
      );
    });

    await test('顺序导出：CSV 沿用基准表头与原单元格值，仅行序重排为父先子后', async () => {
      const r = await jsonReq('/api/order/export', {
        roundId: ordRound,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(r.headers['content-type'].includes('text/csv'));
      assert.ok(r.headers['content-disposition'].includes('import-order.csv'));
      assert.ok(r.text.charCodeAt(0) === 0xfeff, '顺序导出带 UTF-8 BOM');
      const lines = r.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
      assert.deepStrictEqual(lines, [
        'id,parent,name',
        'R2,,根二',
        'R1,,根一',
        'C1,R1,子一',
        'C2,R1,子二',
        'G1,C1,孙一',
      ]);
      // 与合并 CSV 行集合一致（仅行序不同）
      const ex = await jsonReq('/api/export', { roundId: ordRound, decisions: {} });
      assert.strictEqual(ex.status, 200, ex.text);
      const mergedLines = ex.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);
      assert.deepStrictEqual([...lines.slice(1)].sort(), [...mergedLines].sort());
    });

    await test('导入顺序：存在缺失父项 / 循环时列出问题并阻止顺序导出，合并 CSV 仍可用', async () => {
      // hierRound 的层级含缺失父项与循环
      const r = await jsonReq('/api/order', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(r.status, 200, r.text);
      const order = r.json().order;
      assert.strictEqual(order.valid, false);
      assert.strictEqual(order.keys, null);
      assert.deepStrictEqual(
        order.issues.map((i) => [i.key, i.type]),
        [
          ['D', 'missing-parent'],
          ['E', 'cycle'],
          ['F', 'cycle'],
          ['G', 'cycle'],
          ['I', 'missing-parent'],
        ],
      );

      // 顺序导出被阻止：409 并列出问题键与类型
      const ex = await jsonReq('/api/order/export', {
        roundId: hierRound,
        decisions: {},
        parentColumn: 'parent',
      });
      assert.strictEqual(ex.status, 409);
      assert.strictEqual(ex.json().stage, 'hierarchy');
      const msgs = ex.json().errors.map((e) => e.message).join('\n');
      for (const k of ['D', 'E', 'F', 'G', 'I']) assert.ok(msgs.includes(`"${k}"`), k);
      assert.ok(msgs.includes('缺失父项') && msgs.includes('循环'));

      // 原有合并 CSV 导出不受影响
      const merged = await jsonReq('/api/export', { roundId: hierRound, decisions: {} });
      assert.strictEqual(merged.status, 200, merged.text);
    });

    await test('导入顺序：只按服务端模型与裁决计算，无视夹带数据', async () => {
      const r = await jsonReq('/api/order', {
        roundId: ordRound,
        decisions: {},
        parentColumn: 'parent',
        // 伪造的行数据 / 结果：服务端必须忽略
        rows: [['HACK', '', 'x']],
        model: { headers: ['a'], rows: [] },
        order: { keys: [] },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(
        r.json().order.keys.map((k) => k.key),
        ['R2', 'R1', 'C1', 'C2', 'G1'],
      );
    });

    // ---------- 跨轮裁决方案 ----------
    await test('方案导出：未裁决 → 409；全部裁决后可导出', async () => {
      const r409 = await jsonReq('/api/plan/export', { roundId, decisions: {} });
      assert.strictEqual(r409.status, 409);
      assert.strictEqual(r409.json().stage, 'unresolved');

      const r = await jsonReq('/api/plan/export', { roundId, decisions: ledgerDecisions });
      assert.strictEqual(r.status, 200, r.text);
      const plan = r.json().plan;
      assert.strictEqual(plan.keyColumn, 'id');
      assert.deepStrictEqual(plan.headers, ['id', 'name', 'city']);
      assert.strictEqual(plan.roundId, undefined);
      assert.strictEqual(plan.rows.length, 1); // 只有 K1 是冲突行
      assert.strictEqual(plan.rows[0].key, 'K1');
      assert.deepStrictEqual(plan.rows[0].decision.cells, [
        { column: 2, choice: 'manual', value: '最终城市' },
      ]);
      global.__planK1 = plan;
    });

    await test('方案导入：同一轮直接套用，报告列出 applied 且无 skipped', async () => {
      const r = await jsonReq('/api/plan/import', {
        roundId,
        decisions: { rowConflicts: {}, cells: {} },
        plan: global.__planK1,
      });
      assert.strictEqual(r.status, 200, r.text);
      const data = r.json();
      assert.strictEqual(data.report.appliedCount, 1);
      assert.strictEqual(data.report.skippedCount, 0);
      assert.strictEqual(data.report.applied[0].key, 'K1');
      assert.strictEqual(data.decisions.cells.K1[2].choice, 'manual');
      assert.strictEqual(data.decisions.cells.K1[2].value, '最终城市');
      // 套用后的裁决可直接导出 CSV
      const ex = await jsonReq('/api/export', { roundId, decisions: data.decisions });
      assert.strictEqual(ex.status, 200, ex.text);
      assert.ok(ex.text.includes('K1,张三,最终城市'));
    });

    await test('方案导入：该行已有裁决 → 整行跳过（already-decided），不覆盖', async () => {
      const r = await jsonReq('/api/plan/import', {
        roundId,
        decisions: {
          rowConflicts: {},
          cells: { K1: { 2: { choice: 'local' } } },
        },
        plan: global.__planK1,
      });
      assert.strictEqual(r.status, 200, r.text);
      const data = r.json();
      assert.strictEqual(data.report.appliedCount, 0);
      assert.strictEqual(data.report.skipped[0].reason, 'already-decided');
      assert.strictEqual(data.decisions.cells.K1[2].choice, 'local');
    });

    await test('方案导入：行序 / 行号变化的新一轮仍按内容匹配套用', async () => {
      // 同三份文件、完全不同行序的新一轮上传
      const reordered = {
        base: {
          filename: 'base.csv',
          content: 'id,name,city\nK3,王五,广州\nK2,李四,上海\nK1,张三,北京',
        },
        local: {
          filename: 'local.csv',
          content: 'id,name,city\nK2,李四,上海\nK1,张三,深圳',
        },
        remote: {
          filename: 'remote.csv',
          content: 'id,name,city\nK1,张三,杭州\nK3,王五,广州\nK2,李四,上海',
        },
      };
      const rid2 = (await upload(reordered)).json().roundId;
      const mg = await jsonReq('/api/merge', { roundId: rid2, keyColumn: 'id' });
      assert.strictEqual(mg.status, 200, mg.text);
      const r = await jsonReq('/api/plan/import', {
        roundId: rid2,
        decisions: {},
        plan: global.__planK1,
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json().report.appliedCount, 1);
      assert.strictEqual(r.json().decisions.cells.K1[2].value, '最终城市');
    });

    await test('方案导入：原值不同的新一轮整行跳过（values-mismatch）', async () => {
      const changed = {
        base: { filename: 'b.csv', content: 'id,name,city\nK1,张三,北京\nK2,李四,上海' },
        local: { filename: 'l.csv', content: 'id,name,city\nK1,张三,广州' }, // 改成"广州"
        remote: { filename: 'r.csv', content: 'id,name,city\nK1,张三,杭州\nK2,李四,上海' },
      };
      const rid = (await upload(changed)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid, keyColumn: 'id' })).status, 200);
      const r = await jsonReq('/api/plan/import', { roundId: rid, decisions: {}, plan: global.__planK1 });
      assert.strictEqual(r.status, 200, r.text);
      const report = r.json().report;
      assert.strictEqual(report.appliedCount, 0);
      assert.strictEqual(report.skipped[0].reason, 'values-mismatch');
      assert.strictEqual(r.json().decisions.cells.K1, undefined);
    });

    await test('方案导入：键列不一致 → 400，不改动裁决', async () => {
      const r = await jsonReq('/api/plan/import', {
        roundId,
        decisions: { cells: { K1: { 2: { choice: 'local' } } } },
        plan: { ...global.__planK1, keyColumn: 'name' },
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'plan');
    });

    await test('方案导入：表头不一致 → 400', async () => {
      const r = await jsonReq('/api/plan/import', {
        roundId,
        decisions: {},
        plan: { ...global.__planK1, headers: ['id', 'name', 'city2'] },
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'plan');
    });

    await test('方案导入：结构错误（非法 JSON 语义内容）→ 400，不改动任何裁决', async () => {
      const cases = [
        { ...global.__planK1, kind: 'wrong' },
        { ...global.__planK1, version: 9 },
        { ...global.__planK1, rows: 'nope' },
        { ...global.__planK1, rows: [{ key: 'K1' }] },
        null,
        {},
        'string',
      ];
      for (const bad of cases) {
        const r = await jsonReq('/api/plan/import', {
          roundId,
          decisions: { cells: { K1: { 2: { choice: 'remote' } } } },
          plan: bad,
        });
        assert.strictEqual(r.status, 400, `应为 400: ${r.text.slice(0, 120)}`);
        assert.strictEqual(r.json().stage, 'plan');
      }
      // 既有裁决保持原样：K1 仍是远端
      const still = await jsonReq('/api/plan/import', {
        roundId,
        decisions: { cells: { K1: { 2: { choice: 'remote' } } } },
        plan: global.__planK1,
      });
      assert.strictEqual(still.json().decisions.cells.K1[2].choice, 'remote');
    });

    await test('方案接口：roundId 无效 → 404；尚未合并 → 400', async () => {
      const r1 = await jsonReq('/api/plan/export', { roundId: 'nope', decisions: {} });
      assert.strictEqual(r1.status, 404);
      const r2 = await jsonReq('/api/plan/import', {
        roundId: 'nope',
        decisions: {},
        plan: global.__planK1,
      });
      assert.strictEqual(r2.status, 404);
      const fresh = (await upload(SMALL)).json().roundId;
      const r3 = await jsonReq('/api/plan/export', { roundId: fresh, decisions: {} });
      assert.strictEqual(r3.status, 400);
      const r4 = await jsonReq('/api/plan/import', {
        roundId: fresh,
        decisions: {},
        plan: global.__planK1,
      });
      assert.strictEqual(r4.status, 400);
    });

    // ---------- 特殊唯一键 __proto__：页面状态 / 规范化 / 方案往返的串扰回归 ----------
    const PROTO = {
      base: {
        filename: 'base.csv',
        // __proto__ 与普通键 P 两侧都把 v 改成不同值 → 两行都是单元格冲突
        content: 'id,v\n__proto__,b0\nP,p0',
      },
      local: {
        filename: 'local.csv',
        content: 'id,v\n__proto__,lProto\nP,lP',
      },
      remote: {
        filename: 'remote.csv',
        content: 'id,v\n__proto__,rProto\nP,rP',
      },
    };
    const protoRound = (await upload(PROTO)).json().roundId;
    await test('特殊键 __proto__：合并正常识别两行冲突', async () => {
      const r = await jsonReq('/api/merge', { roundId: protoRound, keyColumn: 'id' });
      assert.strictEqual(r.status, 200, r.text);
      const rows = r.json().model.rows;
      assert.deepStrictEqual(
        rows.map((x) => [x.key, x.status]),
        [
          ['__proto__', 'conflict'],
          ['P', 'conflict'],
        ],
      );
      global.__protoModel = r.json().model;
    });

    // 请求体 JSON 中 "__proto__" 是 JSON.parse 得到的自有数据属性
    const protoBoth = JSON.parse(
      '{"rowConflicts":{},"cells":{"__proto__":{"1":{"choice":"local"}},"P":{"1":{"choice":"remote"}}}}',
    );
    const protoOnlyP = JSON.parse(
      '{"rowConflicts":{},"cells":{"P":{"1":{"choice":"remote"}}}}',
    );

    await test('特殊键未裁决（只裁决普通键 P）→ 导出 / 账本 / 层级 / 方案全部 409', async () => {
      for (const urlPath of ['/api/export', '/api/ledger', '/api/plan/export']) {
        const r = await jsonReq(urlPath, { roundId: protoRound, decisions: protoOnlyP });
        assert.strictEqual(r.status, 409, `${urlPath} 应 409: ${r.text.slice(0, 200)}`);
        assert.strictEqual(r.json().stage, 'unresolved');
        assert.ok(r.json().errors[0].message.includes('__proto__'));
      }
      const r = await jsonReq('/api/hierarchy', {
        roundId: protoRound,
        decisions: protoOnlyP,
        parentColumn: 'v',
      });
      assert.strictEqual(r.status, 409, r.text);
      assert.strictEqual(r.json().check, undefined);
    });

    await test('两行均裁决后导出：特殊键取本地、普通键取远端，各自不串扰', async () => {
      const r = await jsonReq('/api/export', { roundId: protoRound, decisions: protoBoth });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(r.text.includes('__proto__,lProto'));
      assert.ok(r.text.includes('P,rP'));
      const dataLines = r.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);
      assert.deepStrictEqual(dataLines, ['__proto__,lProto', 'P,rP']);
      assert.ok(!dataLines.includes('__proto__,rProto'), '特殊键不应错误采用远端值');
      assert.ok(!dataLines.includes('P,lP'), '普通键不应错误采用本地值');
    });

    await test('账本按最终 CSV 行序给出特殊键行且来源正确', async () => {
      const r = await jsonReq('/api/ledger', { roundId: protoRound, decisions: protoBoth });
      assert.strictEqual(r.status, 200, r.text);
      const ledger = r.json().ledger;
      assert.deepStrictEqual(ledger.rows.map((x) => x.key), ['__proto__', 'P']);
      assert.strictEqual(ledger.rows[0].cells[1].source, 'local');
      assert.strictEqual(ledger.rows[1].cells[1].source, 'remote');
    });

    let protoPlan = null;
    await test('方案导出包含 __proto__ 行；导入时只套未裁决行，人工裁决优先', async () => {
      const ex = await jsonReq('/api/plan/export', { roundId: protoRound, decisions: protoBoth });
      assert.strictEqual(ex.status, 200, ex.text);
      protoPlan = ex.json().plan;
      assert.deepStrictEqual(protoPlan.rows.map((x) => x.key), ['__proto__', 'P']);
      assert.strictEqual(protoPlan.rows[0].decision.cells[0].choice, 'local');

      // P 已手动取本地（与方案中的远端冲突）→ P 跳过，__proto__ 正常套用
      const r = await jsonReq('/api/plan/import', {
        roundId: protoRound,
        decisions: JSON.parse(
          '{"rowConflicts":{},"cells":{"P":{"1":{"choice":"local"}}}}',
        ),
        plan: protoPlan,
      });
      assert.strictEqual(r.status, 200, r.text);
      const report = r.json().report;
      assert.strictEqual(report.appliedCount, 1);
      assert.strictEqual(report.skippedCount, 1);
      assert.strictEqual(report.applied[0].key, '__proto__');
      assert.strictEqual(report.skipped[0].key, 'P');
      assert.strictEqual(report.skipped[0].reason, 'already-decided');
      // 服务端返回的裁决 JSON 必须保留特殊键，且 P 保持人工选择
      const returned = r.json().decisions;
      assert.ok(Object.prototype.hasOwnProperty.call(returned.cells, '__proto__'));
      assert.strictEqual(returned.cells.__proto__[1].choice, 'local');
      assert.strictEqual(returned.cells.P[1].choice, 'local');
    });

    await test('方案套用后可直接导出 / 出账本；原型链不被污染', async () => {
      const r = await jsonReq('/api/plan/import', {
        roundId: protoRound,
        decisions: { rowConflicts: {}, cells: {} },
        plan: protoPlan,
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(Object.prototype.hasOwnProperty.call(r.json().decisions.cells, '__proto__'));
      const ex = await jsonReq('/api/export', {
        roundId: protoRound,
        decisions: r.json().decisions,
      });
      assert.strictEqual(ex.status, 200, ex.text);
      assert.ok(ex.text.includes('__proto__,lProto'));
      assert.ok(ex.text.includes('P,rP'));
      // 服务进程 Object.prototype 上不应出现裁决留下的任何属性
      assert.strictEqual(Object.getOwnPropertyDescriptor(Object.prototype, '1'), undefined);
      assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
    });

    // ---------- 疑似唯一键变更核对 ----------
    // 基准 G1/G2/G3 被两侧删除（消失键），KEEP 保留；两侧新增 N1..N3（新增键）
    const KC = {
      base: {
        filename: 'base.csv',
        content: 'id,name,city\nG1,张三,北京\nG2,李四,上海\nG3,王五,广州\nKEEP,保留,不变',
      },
      local: {
        filename: 'local.csv',
        content: 'id,name,city\nKEEP,保留,不变\nN1,张三,北京\nN2,李四,深圳\nN3,赵六,杭州',
      },
      remote: {
        filename: 'remote.csv',
        content: 'id,name,city\nKEEP,保留,不变\nN1,张三,北京\nN2,李四,深圳\nN3,赵六,杭州',
      },
    };
    const kcRound = (await upload(KC)).json().roundId;
    assert.strictEqual(
      (await jsonReq('/api/merge', { roundId: kcRound, keyColumn: 'id' })).status,
      200,
    );

    await test('核对：roundId 无效 → 404；尚未合并 → 400', async () => {
      let r = await jsonReq('/api/keycheck', {
        roundId: 'nope',
        decisions: {},
        columns: ['name'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
      const fresh = (await upload(KC)).json().roundId;
      r = await jsonReq('/api/keycheck', {
        roundId: fresh,
        decisions: {},
        columns: ['name'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
    });

    await test('核对：参数非法 → 400（未选比较列 / 唯一键作比较列 / 差异上限越界）', async () => {
      const bad = [
        [{ columns: [], maxDiff: 0 }, '至少'],
        [{ columns: ['id'], maxDiff: 0 }, '唯一键'],
        [{ columns: ['nope'], maxDiff: 0 }, '不在表头'],
        [{ columns: ['name', 'name'], maxDiff: 0 }, '重复'],
        [{ columns: ['name'], maxDiff: -1 }, '差异上限'],
        [{ columns: ['name'], maxDiff: 2 }, '差异上限'],
        [{ columns: ['name'], maxDiff: 0.5 }, '差异上限'],
        [{ columns: null, maxDiff: 0 }, '至少'],
      ];
      for (const [patch, msg] of bad) {
        const r = await jsonReq('/api/keycheck', {
          roundId: kcRound,
          decisions: {},
          columns: ['name'],
          maxDiff: 0,
          ...patch,
        });
        assert.strictEqual(r.status, 400, `${JSON.stringify(patch)} → ${r.text.slice(0, 120)}`);
        assert.ok(r.json().errors[0].message.includes(msg), r.json().errors[0].message);
      }
    });

    await test('核对：有未决冲突 → 409，不给出结论', async () => {
      // SMALL 这一轮还有 K1 的单元格冲突未裁决
      const r = await jsonReq('/api/keycheck', {
        roundId,
        decisions: {},
        columns: ['name'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
      assert.strictEqual(r.json().check, undefined);
    });

    let kcCheck = null;
    await test('核对：返回最优配对数 / 总代价 / 候选代价与逐旧键可能性', async () => {
      const r = await jsonReq('/api/keycheck', {
        roundId: kcRound,
        decisions: {},
        columns: ['name', 'city'],
        maxDiff: 1,
      });
      assert.strictEqual(r.status, 200, r.text);
      kcCheck = r.json().check;
      assert.strictEqual(kcCheck.oldCount, 3);
      assert.strictEqual(kcCheck.newCount, 3);
      assert.strictEqual(kcCheck.pairCount, 2);
      assert.strictEqual(kcCheck.totalCost, 1);
      assert.strictEqual(kcCheck.candidateCount, 2);
      assert.strictEqual(kcCheck.candidateCost, 1);
      assert.deepStrictEqual(
        kcCheck.pairs.map((p) => [p.oldKey, p.newKey, p.cost]),
        [
          ['G1', 'N1', 0],
          ['G2', 'N2', 1],
        ],
      );
      const byKey = Object.fromEntries(kcCheck.oldKeys.map((k) => [k.key, k]));
      assert.strictEqual(byKey.G1.stable, true);
      assert.strictEqual(byKey.G1.stableNewKey, 'N1');
      assert.strictEqual(byKey.G2.stable, true);
      assert.deepStrictEqual(byKey.G3.possibleNewKeys, []);
      assert.strictEqual(byKey.G3.canBeUnpaired, true);
      assert.deepStrictEqual(kcCheck.unpairedOldKeys, ['G3']);
      assert.deepStrictEqual(kcCheck.unpairedNewKeys, ['N3']);
      assert.ok(kcCheck.disclaimer.includes('不能认定为真实改名'));
    });

    await test('核对：只按服务端模型与裁决计算，无视夹带数据，且不影响数据与裁决', async () => {
      const r = await jsonReq('/api/keycheck', {
        roundId: kcRound,
        decisions: {},
        columns: ['name', 'city'],
        maxDiff: 1,
        // 伪造的行数据 / 结果：服务端必须忽略
        rows: [['HACK', 'x', 'y']],
        model: { headers: ['a'], rows: [] },
        check: { pairs: [] },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json().check.pairs, kcCheck.pairs);
      assert.ok(!JSON.stringify(r.json().check).includes('HACK'));
      // 核对只读：合并 CSV 导出内容不受任何影响
      const ex = await jsonReq('/api/export', { roundId: kcRound, decisions: {} });
      assert.strictEqual(ex.status, 200, ex.text);
      const lines = ex.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
      assert.strictEqual(lines.length, 5); // 表头 + KEEP + N1..N3
      assert.ok(lines.includes('KEEP,保留,不变'));
    });

    await test('核对：任一组为空时返回空配对并列出未配对旧键', async () => {
      // SMALL 裁决后：K3 消失、无新增键 → 空配对，K3 列入未配对旧键
      const r = await jsonReq('/api/keycheck', {
        roundId,
        decisions: ledgerDecisions,
        columns: ['name'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 200, r.text);
      const check = r.json().check;
      assert.strictEqual(check.oldCount, 1);
      assert.strictEqual(check.newCount, 0);
      assert.strictEqual(check.pairCount, 0);
      assert.strictEqual(check.totalCost, 0);
      assert.deepStrictEqual(check.pairs, []);
      assert.deepStrictEqual(check.unpairedOldKeys, ['K3']);
      assert.deepStrictEqual(check.unpairedNewKeys, []);
      assert.strictEqual(check.oldKeys[0].key, 'K3');
      assert.strictEqual(check.oldKeys[0].canBeUnpaired, true);
      assert.strictEqual(check.oldKeys[0].stable, false);
    });

    await test('核对：任一组超过 12 个 → 409 stage=limit 并给出两组数量', async () => {
      const many = (prefix, count) =>
        Array.from({ length: count }, (_, i) => `${prefix}${i},v${i}`).join('\n');
      // 13 个消失键
      const gone = {
        base: { filename: 'b.csv', content: `id,v\n${many('O', 13)}` },
        local: { filename: 'l.csv', content: 'id,v\nK,keep' },
        remote: { filename: 'r.csv', content: 'id,v\nK,keep' },
      };
      const rid1 = (await upload(gone)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid1, keyColumn: 'id' })).status, 200);
      let r = await jsonReq('/api/keycheck', {
        roundId: rid1,
        decisions: {},
        columns: ['v'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'limit');
      assert.strictEqual(r.json().oldCount, 13);
      assert.strictEqual(r.json().newCount, 1);
      assert.strictEqual(r.json().limit, 12);
      assert.ok(r.json().errors[0].message.includes('12'));
      // 13 个新增键
      const added = {
        base: { filename: 'b.csv', content: 'id,v\nK,keep' },
        local: { filename: 'l.csv', content: `id,v\nK,keep\n${many('N', 13)}` },
        remote: { filename: 'r.csv', content: `id,v\nK,keep\n${many('N', 13)}` },
      };
      const rid2 = (await upload(added)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid2, keyColumn: 'id' })).status, 200);
      r = await jsonReq('/api/keycheck', {
        roundId: rid2,
        decisions: {},
        columns: ['v'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'limit');
      assert.strictEqual(r.json().newCount, 13);
      // 恰好 12 个不受限
      const twelve = {
        base: { filename: 'b.csv', content: `id,v\n${many('O', 12)}` },
        local: { filename: 'l.csv', content: 'id,v\nK,keep' },
        remote: { filename: 'r.csv', content: 'id,v\nK,keep' },
      };
      const rid3 = (await upload(twelve)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid3, keyColumn: 'id' })).status, 200);
      r = await jsonReq('/api/keycheck', {
        roundId: rid3,
        decisions: {},
        columns: ['v'],
        maxDiff: 0,
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json().check.oldCount, 12);
      assert.strictEqual(r.json().check.pairCount, 0);
    });

    // ---------- 最小决定列发现 ----------
    // id 唯一键；c 由单列 d 决定，也由 (a,b) 联合决定；e 恒定；K1=K4 重复。无冲突。
    const DET = {
      base: {
        filename: 'base.csv',
        content:
          'id,a,b,c,d,e\nK1,1,1,X,9,C\nK2,1,2,Y,8,C\nK3,2,1,Z,7,C\nK4,1,1,X,9,C',
      },
      local: { filename: 'local.csv', content: 'id,a,b,c,d,e\nK1,1,1,X,9,C\nK2,1,2,Y,8,C\nK3,2,1,Z,7,C\nK4,1,1,X,9,C' },
      remote: { filename: 'remote.csv', content: 'id,a,b,c,d,e\nK1,1,1,X,9,C\nK2,1,2,Y,8,C\nK3,2,1,Z,7,C\nK4,1,1,X,9,C' },
    };
    const detRound = (await upload(DET)).json().roundId;
    assert.strictEqual(
      (await jsonReq('/api/merge', { roundId: detRound, keyColumn: 'id' })).status,
      200,
    );

    await test('发现：roundId 无效 → 404；尚未合并 → 400', async () => {
      let r = await jsonReq('/api/determinants', {
        roundId: 'nope',
        decisions: {},
        targetColumn: 'c',
        candidateColumns: ['a'],
      });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
      const fresh = (await upload(DET)).json().roundId;
      r = await jsonReq('/api/determinants', {
        roundId: fresh,
        decisions: {},
        targetColumn: 'c',
        candidateColumns: ['a'],
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
    });

    await test('发现：参数非法 → 400（目标列 / 候选列）', async () => {
      const bad = [
        [{ targetColumn: '', candidateColumns: ['a'] }, '缺少'],
        [{ targetColumn: 'nope', candidateColumns: ['a'] }, '不在表头'],
        [{ targetColumn: 'id', candidateColumns: ['a'] }, '唯一键'],
        [{ targetColumn: 'a', candidateColumns: [] }, '至少'],
        [{ targetColumn: 'a', candidateColumns: ['id'] }, '唯一键'],
        [{ targetColumn: 'a', candidateColumns: ['a'] }, '目标列'],
        [{ targetColumn: 'a', candidateColumns: ['b', 'b'] }, '重复'],
        [{ targetColumn: 'a', candidateColumns: ['nope'] }, '不在表头'],
        [{ targetColumn: 'a', candidateColumns: null }, '必须是'],
      ];
      for (const [patch, msg] of bad) {
        const r = await jsonReq('/api/determinants', {
          roundId: detRound,
          decisions: {},
          targetColumn: 'c',
          candidateColumns: ['a'],
          ...patch,
        });
        assert.strictEqual(r.status, 400, `${JSON.stringify(patch)} → ${r.text.slice(0, 120)}`);
        assert.ok(r.json().errors[0].message.includes(msg), r.json().errors[0].message);
      }
      // 候选列超过 10 个
      const manyCols = Array.from({ length: 11 }, (_, i) => `x${i}`);
      const wide = {
        base: { filename: 'b.csv', content: `id,t,${manyCols.join(',')}\nK,v,${manyCols.map((_, i) => i).join(',')}` },
        local: { filename: 'l.csv', content: `id,t,${manyCols.join(',')}\nK,v,${manyCols.map((_, i) => i).join(',')}` },
        remote: { filename: 'r.csv', content: `id,t,${manyCols.join(',')}\nK,v,${manyCols.map((_, i) => i).join(',')}` },
      };
      const wr = (await upload(wide)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: wr, keyColumn: 'id' })).status, 200);
      const r = await jsonReq('/api/determinants', {
        roundId: wr,
        decisions: {},
        targetColumn: 't',
        candidateColumns: manyCols,
      });
      assert.strictEqual(r.status, 400, r.text);
      assert.ok(r.json().errors[0].message.includes('10'));
    });

    await test('发现：有未决冲突 → 409，不给出结论', async () => {
      const r = await jsonReq('/api/determinants', {
        roundId,
        decisions: {},
        targetColumn: 'city',
        candidateColumns: ['name'],
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'unresolved');
      assert.strictEqual(r.json().analysis, undefined);
    });

    let detAnalysis = null;
    await test('发现：返回所有最小组合、逐列移除证明；只读且无视夹带数据', async () => {
      const r = await jsonReq('/api/determinants', {
        roundId: detRound,
        decisions: {},
        targetColumn: 'c',
        candidateColumns: ['a', 'b', 'd', 'e'],
        // 伪造数据：服务端必须忽略
        rows: [['HACK', '1', '2', '3', '4', '5']],
        analysis: { combinations: [] },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json().emptyData, false);
      detAnalysis = r.json().analysis;
      assert.strictEqual(detAnalysis.targetColumn, 'c');
      assert.strictEqual(detAnalysis.rowCount, 4);
      assert.strictEqual(detAnalysis.limit, 300);
      assert.strictEqual(detAnalysis.constant, false);
      assert.deepStrictEqual(
        detAnalysis.combinations.map((c) => c.columns),
        [['d'], ['a', 'b']],
      );
      const [single, pair] = detAnalysis.combinations;
      assert.strictEqual(single.witnesses[0].removedColumn, 'd');
      assert.deepStrictEqual(
        [single.witnesses[0].pair.first.key, single.witnesses[0].pair.second.key],
        ['K1', 'K2'],
      );
      assert.deepStrictEqual(
        [single.witnesses[0].pair.first.targetValue, single.witnesses[0].pair.second.targetValue],
        ['X', 'Y'],
      );
      assert.deepStrictEqual(pair.witnesses.map((w) => w.removedColumn), ['a', 'b']);
      assert.ok(!JSON.stringify(detAnalysis).includes('HACK'));
      assert.ok(detAnalysis.disclaimer.includes('只适用于当前数据'));
      // 只读：合并 CSV 导出不受影响
      const ex = await jsonReq('/api/export', { roundId: detRound, decisions: {} });
      assert.strictEqual(ex.status, 200, ex.text);
    });

    await test('发现：目标恒定 → 空组合；无组合 → 全候选列反例', async () => {
      let r = await jsonReq('/api/determinants', {
        roundId: detRound,
        decisions: {},
        targetColumn: 'e',
        candidateColumns: ['a', 'b'],
      });
      assert.strictEqual(r.status, 200, r.text);
      const a = r.json().analysis;
      assert.strictEqual(a.constant, true);
      assert.deepStrictEqual(a.combinations, [{ size: 0, columns: [], witnesses: [] }]);
      assert.strictEqual(a.counterexample, null);

      // 目标 a、候选 b：b=1 对应 a=1(K1) / 2(K3) → 无组合，给反例
      r = await jsonReq('/api/determinants', {
        roundId: detRound,
        decisions: {},
        targetColumn: 'a',
        candidateColumns: ['b'],
      });
      assert.strictEqual(r.status, 200, r.text);
      const a2 = r.json().analysis;
      assert.strictEqual(a2.combinationCount, 0);
      assert.deepStrictEqual(a2.combinations, []);
      assert.deepStrictEqual(a2.counterexample.columns, ['b']);
      assert.deepStrictEqual(
        [a2.counterexample.pair.first.key, a2.counterexample.pair.second.key],
        ['K1', 'K3'],
      );
      assert.deepStrictEqual(
        [a2.counterexample.pair.first.targetValue, a2.counterexample.pair.second.targetValue],
        ['1', '2'],
      );
    });

    await test('发现：无最终保留行 → 200 且 emptyData=true；300 行允许、301 行 → 409', async () => {
      // 两侧都删除：最终保留行为空
      const gone = {
        base: { filename: 'b.csv', content: 'id,a,b\nK1,1,x' },
        local: { filename: 'l.csv', content: 'id,a,b' },
        remote: { filename: 'r.csv', content: 'id,a,b' },
      };
      const rid = (await upload(gone)).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid, keyColumn: 'id' })).status, 200);
      let r = await jsonReq('/api/determinants', {
        roundId: rid,
        decisions: {},
        targetColumn: 'b',
        candidateColumns: ['a'],
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json().emptyData, true);
      assert.strictEqual(r.json().analysis, undefined);

      const mkFiles = (n) => {
        const body = 'id,a,b\n' + Array.from({ length: n }, (_, i) => `K${i},${i},v${i}`).join('\n');
        return {
          base: { filename: 'b.csv', content: body },
          local: { filename: 'l.csv', content: body },
          remote: { filename: 'r.csv', content: body },
        };
      };
      const rid300 = (await upload(mkFiles(300))).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid300, keyColumn: 'id' })).status, 200);
      r = await jsonReq('/api/determinants', {
        roundId: rid300,
        decisions: {},
        targetColumn: 'b',
        candidateColumns: ['a'],
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json().analysis.rowCount, 300);

      const rid301 = (await upload(mkFiles(301))).json().roundId;
      assert.strictEqual((await jsonReq('/api/merge', { roundId: rid301, keyColumn: 'id' })).status, 200);
      r = await jsonReq('/api/determinants', {
        roundId: rid301,
        decisions: {},
        targetColumn: 'b',
        candidateColumns: ['a'],
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json().stage, 'limit');
      assert.strictEqual(r.json().rowCount, 301);
      assert.strictEqual(r.json().limit, 300);
    });

    // ---------- 标识无效 / 过期 / 串轮 ----------
    await test('合并使用不存在的 roundId → 404 且明确提示重新上传', async () => {
      const r = await jsonReq('/api/merge', { roundId: 'deadbeef'.repeat(8), keyColumn: 'id' });
      assert.strictEqual(r.status, 404);
      const data = r.json();
      assert.strictEqual(data.stage, 'round');
      assert.ok(data.errors[0].message.includes('重新上传'));
    });

    await test('导出使用不存在的 roundId → 404', async () => {
      const r = await jsonReq('/api/export', { roundId: 'nope', decisions: {} });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json().stage, 'round');
    });

    await test('有效轮次但尚未合并就导出 → 400（而不是误用其他轮模型）', async () => {
      const fresh = (await upload(SMALL)).json().roundId;
      const r = await jsonReq('/api/export', { roundId: fresh, decisions: {} });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json().stage, 'request');
    });

    await test('两轮数据互不串用', async () => {
      // A 轮：3 列 id/name/city
      const aId = (await upload(SMALL)).json().roundId;
      // B 轮：2 列 id/value，键列完全不同
      const bFiles = {
        base: { filename: 'b.csv', content: 'id,value\nA1,1\nA2,2' },
        local: { filename: 'l.csv', content: 'id,value\nA1,1\nA2,2' },
        remote: { filename: 'r.csv', content: 'id,value\nA1,1\nA2,2' },
      };
      const bId = (await upload(bFiles)).json().roundId;

      const rb = await jsonReq('/api/merge', { roundId: bId, keyColumn: 'id' });
      assert.strictEqual(rb.status, 200, rb.text);
      assert.deepStrictEqual(rb.json().model.headers, ['id', 'value']);

      // 再操作 A 轮：必须拿到 A 的 3 列表头与 K* 键，不能被 B 轮覆盖
      const ra = await jsonReq('/api/merge', { roundId: aId, keyColumn: 'id' });
      assert.strictEqual(ra.status, 200, ra.text);
      const ma = ra.json().model;
      assert.deepStrictEqual(ma.headers, ['id', 'name', 'city']);
      assert.ok(ma.rows.some((x) => x.key === 'K1'));
      assert.ok(!ma.rows.some((x) => x.key === 'A1'));

      // B 轮没有模型被 A 的合并覆盖：B 仍可正常导出
      const ex = await jsonReq('/api/export', { roundId: bId, decisions: {} });
      assert.strictEqual(ex.status, 200, ex.text);
      assert.ok(ex.text.includes('A1,1'));
    });

    await test('RoundStore 过期后取不到数据', async () => {
      const store = new RoundStore({ ttlMs: 50, maxRounds: 10 });
      const id = store.create({ base: {}, local: {}, remote: {} });
      assert.ok(store.get(id));
      await new Promise((r) => setTimeout(r, 90));
      assert.strictEqual(store.get(id), null);
    });

    await test('RoundStore 超过上限淘汰最旧轮，且随机标识不重复', async () => {
      const store = new RoundStore({ ttlMs: 60000, maxRounds: 3 });
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(store.create({ base: { i }, local: {}, remote: {} }));
      assert.strictEqual(new Set(ids).size, 5);
      assert.strictEqual(store.get(ids[0]), null);
      assert.strictEqual(store.get(ids[1]), null);
      assert.ok(store.get(ids[4]));
    });

    // ---------- 大文件 ----------
    // 每份约 8 MiB、未超过单文件 20 MiB 限额；旧流程把三份解析结果放进
    // JSON 合并请求会超过 20 MiB 请求体上限。新流程只传 roundId。
    const ROWS = 60000;
    // 约 30 个中文字符（≈ 90 字节 UTF-8）的填充文本，保证每行约 140 字节、
    // 整份文件约 8 MiB
    const PAD =
      '一些用于撑大体积的中文说明内容请保持为合法的普通文本无需引号就可以被解析的填充数据';
    function bigFile(mod) {
      const lines = ['id,name,note'];
      for (let i = 0; i < ROWS; i++) {
        let name = 'n' + i;
        if (i === 1 && mod === 'local') name = '本地改';
        if (i === 1 && mod === 'remote') name = '远端改';
        lines.push(`k${i},${name},${PAD}_${i}`);
      }
      return lines.join('\n') + '\n';
    }

    await test('三份约 8 MiB 的合法 CSV：上传 → 合并 → 裁决 → 导出全程可用', async () => {
      const files = {
        base: { filename: 'base.csv', content: bigFile('base') },
        local: { filename: 'local.csv', content: bigFile('local') },
        remote: { filename: 'remote.csv', content: bigFile('remote') },
      };
      // 确认每份约 8 MiB 且都低于 20 MiB 单文件限额
      for (const f of Object.values(files)) {
        const size = Buffer.byteLength(f.content, 'utf8');
        assert.ok(size > 7 * 1024 * 1024, `size=${size}`);
        assert.ok(size < 20 * 1024 * 1024, `size=${size}`);
      }

      const up = await upload(files);
      assert.strictEqual(up.status, 200, up.text.slice(0, 500));
      const bigRound = up.json().roundId;
      assert.strictEqual(up.json().files.base.rowCount, ROWS);

      // 新流程：请求体只有 roundId + keyColumn
      const mg = await jsonReq('/api/merge', { roundId: bigRound, keyColumn: 'id' });
      assert.strictEqual(mg.status, 200, mg.text.slice(0, 500));
      const model = mg.json().model;
      const k1 = model.rows.find((r) => r.key === 'k1');
      assert.strictEqual(k1.status, 'conflict');
      assert.strictEqual(k1.conflicts[0].type, 'cell');
      assert.strictEqual(model.summary.total, ROWS);

      const ex = await jsonReq('/api/export', {
        roundId: bigRound,
        decisions: { rowConflicts: {}, cells: { k1: { 1: { choice: 'local' } } } },
      });
      assert.strictEqual(ex.status, 200, ex.text.slice(0, 500));
      const outLines = ex.text.split(/\r?\n/).filter(Boolean);
      assert.strictEqual(outLines.length, ROWS + 1); // 表头 + 60000 行
      assert.ok(outLines.some((l) => l.startsWith('k1,本地改,')), 'k1 应采纳本地值');
      assert.ok(Buffer.byteLength(ex.text, 'utf8') > 7 * 1024 * 1024);
    });

    await test('回归保护：旧契约式超大 JSON 合并请求仍会被 20 MiB 上限拒绝（413）', async () => {
      // 如果哪天客户端又开始回传整份数据，服务端应当像从前一样拒绝超大请求体
      const padding = 'x'.repeat(21 * 1024 * 1024);
      const r = await jsonReq('/api/merge', { roundId: 'x', keyColumn: 'id', padding });
      assert.strictEqual(r.status, 413);
      assert.strictEqual(r.json().stage, 'request');
    });

    await test('超过 20 MiB 的单文件上传 → 413 JSON 错误', async () => {
      const big = {
        base: { filename: 'base.csv', content: 'id\n' + 'x'.repeat(21 * 1024 * 1024) },
        local: { filename: 'local.csv', content: 'id\n1' },
        remote: { filename: 'remote.csv', content: 'id\n1' },
      };
      const r = await upload(big);
      assert.strictEqual(r.status, 413);
      const data = r.json();
      assert.strictEqual(data.ok, false);
      assert.ok(data.errors[0].message.includes('20 MiB'));
    });

    console.log(`\n全部 ${passed} 个 HTTP 测试通过`);
  } catch (e) {
    console.error('测试失败:', e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
