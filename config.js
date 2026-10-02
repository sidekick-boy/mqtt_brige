'use strict';

/**
 * 服务配置
 * 所有配置均可通过环境变量覆盖，方便部署时调整，无需改代码。
 */

const path = require('path');

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

module.exports = {
  // HTTP 监听地址 / 端口（对应桥接配置里的 http://localhost:18339/content）
  host: process.env.HOST || '0.0.0.0',
  port: envInt('PORT', 18339),

  // 接收消息的路由路径
  routePath: process.env.ROUTE_PATH || '/content',

  // 日志（业务数据）输出目录
  logDir: process.env.LOG_DIR || path.join(__dirname, 'data'),

  // 日志文件名前缀，最终文件名形如 content-2026-10-02.txt
  logPrefix: process.env.LOG_PREFIX || 'content',

  // 是否按天分割日志文件（true: content-YYYY-MM-DD.txt；false: content.txt）
  rotateDaily: envBool('ROTATE_DAILY', true),

  // 单条请求体最大字节数，超过则拒绝（防止异常大包打爆内存）
  maxBodyBytes: envInt('MAX_BODY_BYTES', 5 * 1024 * 1024),

  // 是否把每条消息也打印到控制台
  echoConsole: envBool('ECHO_CONSOLE', true),

  // 写入每行时是否带上接收时间戳
  withTimestamp: envBool('WITH_TIMESTAMP', true),
};
