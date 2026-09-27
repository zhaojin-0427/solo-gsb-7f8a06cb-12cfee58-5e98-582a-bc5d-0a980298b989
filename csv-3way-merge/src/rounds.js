'use strict';

/**
 * 服务端"本轮"会话存储。
 *
 * 大文件（每份接近 20 MiB）的解析结果与合并模型体积很大，不能随合并 / 导出
 * 请求反复在浏览器与服务端之间传输。上传成功后由服务端生成一个 roundId，
 * 后续请求只带 roundId + 键列 + 冲突决策；数据只保留在服务端内存中，
 * 重启即清空，不写入磁盘。
 *
 * 每个会话采用滑动过期（最后一次访问后 TTL_MS 失效），并通过定期扫描清理，
 * 避免长时间驻留占用内存。roundId 使用加密随机字节，无法被猜测或枚举。
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = Number(process.env.ROUND_TTL_MS) || 60 * 60 * 1000;
const DEFAULT_MAX_ROUNDS = Number(process.env.ROUND_MAX_ROUNDS) || 50;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

class RoundStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxRounds = DEFAULT_MAX_ROUNDS } = {}) {
    this.ttlMs = ttlMs;
    this.maxRounds = maxRounds;
    /** @type {Map<string, {parsed: object, model?: object, expiresAt: number}>} */
    this.rounds = new Map();

    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // 不阻止进程退出（测试中 Node 可正常结束）
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 创建本轮会话，返回随机标识。
   * @param {{base: object, local: object, remote: object}} parsed 三份解析结果
   * @returns {string} roundId
   */
  create(parsed) {
    // 上限保护：超出时丢弃最久未访问的一轮，避免内存被反复上传占满
    while (this.rounds.size >= this.maxRounds) {
      const oldest = this.rounds.keys().next().value;
      if (oldest === undefined) break;
      this.rounds.delete(oldest);
    }

    const roundId = crypto.randomBytes(24).toString('hex');
    this.rounds.set(roundId, {
      parsed,
      model: null,
      expiresAt: Date.now() + this.ttlMs,
    });
    return roundId;
  }

  /**
   * 取本轮数据；标识不存在或已过期一律返回 null（过期项顺手删除），
   * 调用方必须明确报错，绝不能回退到其他轮数据。
   */
  get(roundId) {
    if (typeof roundId !== 'string' || roundId.length === 0) return null;
    const round = this.rounds.get(roundId);
    if (!round) return null;
    if (round.expiresAt <= Date.now()) {
      this.rounds.delete(roundId);
      return null;
    }
    round.expiresAt = Date.now() + this.ttlMs;
    return round;
  }

  sweep() {
    const now = Date.now();
    for (const [id, round] of this.rounds) {
      if (round.expiresAt <= now) this.rounds.delete(id);
    }
  }
}

module.exports = { RoundStore, DEFAULT_TTL_MS, DEFAULT_MAX_ROUNDS };
