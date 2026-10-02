'use strict';

/**
 * 业务数据落盘模块
 * - 负责把收到的消息追加写入本地 txt 文件
 * - 支持按天分割文件
 * - 使用串行化的追加写入，保证并发请求下写入不会交错错乱
 */

const fs = require('fs');
const path = require('path');

class FileLogger {
  constructor(config) {
    this.config = config;
    this.writeChain = Promise.resolve(); // 串行写入队列，避免并发写交错
    this._ensureDir();
  }

  _ensureDir() {
    fs.mkdirSync(this.config.logDir, { recursive: true });
  }

  /** 根据配置生成当前应写入的文件完整路径 */
  currentFilePath() {
    const { logDir, logPrefix, rotateDaily } = this.config;
    if (!rotateDaily) {
      return path.join(logDir, `${logPrefix}.txt`);
    }
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return path.join(logDir, `${logPrefix}-${y}-${m}-${day}.txt`);
  }

  /**
   * 追加一行记录。
   * @param {object} record { topic, payload, raw }
   * @returns {Promise<string>} 实际写入的文本行
   */
  append(record) {
    const line = this._formatLine(record);
    const file = this.currentFilePath();

    // 把本次写入挂到串行队列尾部
    this.writeChain = this.writeChain.then(
      () =>
        new Promise((resolve, reject) => {
          fs.appendFile(file, line, 'utf8', (err) => {
            if (err) reject(err);
            else resolve();
          });
        })
    );

    return this.writeChain.then(() => line.replace(/\n$/, ''));
  }

  _formatLine(record) {
    const parts = [];
    if (this.config.withTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }
    if (record.topic) {
      parts.push(`topic=${record.topic}`);
    }
    // payload 统一序列化成单行字符串
    let payloadStr;
    if (typeof record.payload === 'string') {
      payloadStr = record.payload;
    } else if (record.payload !== undefined) {
      payloadStr = JSON.stringify(record.payload);
    } else {
      payloadStr = record.raw ?? '';
    }
    // 去掉内部换行，保证一条消息一行，便于后续按行解析
    payloadStr = String(payloadStr).replace(/\r?\n/g, '\\n');
    parts.push(`payload=${payloadStr}`);

    return parts.join(' ') + '\n';
  }
}

module.exports = FileLogger;
