'use strict';

/**
 * 合并结果来源账本。
 *
 * 冲突全部裁决后，按最终 CSV 行序逐键、逐格记录：最终值、取值来源
 * （基准 / 本地 / 远端 / 两侧 / 人工）以及来源文件中的物理行号；
 * 被删除的键不混入输出行，单独列出删除原因。
 *
 * 账本的逐格取值与 CSV 导出共用 merge.js 中的 resolveRowProvenance，
 * 两边不可能出现不一致；且完全由服务端按本轮保存的模型与裁决计算，
 * 不采用浏览器回传的任何行数据。
 */

const { resolveRowProvenance } = require('./merge');

/** 取值来源 → 中文说明（JSON 账本中作为图例，页面展示也使用同一套文案） */
const SOURCE_LABELS = {
  base: '基准（未改动）',
  local: '本地',
  remote: '远端',
  both: '两侧相同',
  manual: '人工填写',
};

/** 删除原因 → 中文说明 */
const DELETE_REASON_LABELS = {
  'both-deleted': '本地与远端都删除了该行',
  'local-deleted': '本地删除了该行，远端未改动',
  'remote-deleted': '远端删除了该行，本地未改动',
  'decision-delete-modify': '一侧删除、另一侧修改的行级冲突，经人工裁决删除该行',
  'decision-add-divergent': '两侧新增同一键但内容不同，经人工裁决不加入该行',
};

/**
 * 生成来源账本。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @returns {{ ledger: object, unresolved: number, unresolvedDetails: string[] }}
 *   ledger.rows    与最终 CSV 完全同序、同值；每个单元格：
 *                  { column, value, source, sourceText, lines }
 *                  lines 为 { base?, local?, remote? } 的物理行号；人工填写为 null
 *   ledger.deleted 被删除的键及原因：{ key, reason, reasonText, lines }
 */
function buildLedger(model, decisions) {
  const rows = [];
  const deleted = [];
  const unresolvedDetails = [];

  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, model.headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);

    if (res.deleted) {
      const lines = {};
      if (row.base) lines.base = row.base.line;
      if (row.local) lines.local = row.local.line;
      if (row.remote) lines.remote = row.remote.line;
      deleted.push({
        key: row.key,
        reason: res.deleteReason,
        reasonText: DELETE_REASON_LABELS[res.deleteReason] || res.deleteReason,
        lines,
      });
      continue;
    }

    rows.push({
      key: row.key,
      cells: res.cells.map((value, c) => ({
        column: model.headers[c],
        value,
        source: res.sources[c].source,
        sourceText: SOURCE_LABELS[res.sources[c].source],
        lines: res.sources[c].lines,
      })),
    });
  }

  const ledger = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    headers: model.headers,
    sourceLegend: SOURCE_LABELS,
    deleteReasonLegend: DELETE_REASON_LABELS,
    rowCount: rows.length,
    deletedCount: deleted.length,
    rows,
    deleted,
  };

  return { ledger, unresolved: unresolvedDetails.length, unresolvedDetails };
}

module.exports = { buildLedger, SOURCE_LABELS, DELETE_REASON_LABELS };
