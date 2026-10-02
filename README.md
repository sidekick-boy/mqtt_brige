# MQTT 桥接数据接收服务 (HTTP Sink)

配合 MQTT 规则引擎（如 EMQX / NanoMQ 的「HTTP 服务」动作）使用。规则引擎把
`C1/+/M` 主题的消息 `POST` 到本服务，本服务把每条消息内容**追加写入本地 txt 文件**。

对应你截图里的桥接配置：

| 配置项 | 值 |
| --- | --- |
| 请求方法 | `POST` |
| URL | `http://localhost:18339/content` |
| 请求头 | `content-type: application/json` |

本服务即这个 URL 的接收端。

## 消息流向

```
MQTT 设备 ──发布──> broker (主题 C1/+/M)
                      │
          规则引擎「HTTP 服务」动作
                      │  POST http://localhost:18339/content
                      ▼
            本服务 (server.js)  ──追加写入──>  data/content-YYYY-MM-DD.txt
```

> `C1/+/M` 中的 `+` 是单层通配符，匹配 `C1/device01/M`、`C1/device02/M` 等。
> 实际做订阅/过滤的是 MQTT 规则引擎，本服务只负责接收被桥接出来的 HTTP 请求并落盘。

## 运行

```bash
# Node.js >= 18，无需任何第三方依赖
node server.js
```

启动后监听 `0.0.0.0:18339`，路由 `POST /content`。

## 输出文件

默认写到 `./data/content-YYYY-MM-DD.txt`，每条消息一行：

```
[2026-10-02T06:51:41.650Z] topic=C1/device01/M payload={"temp":25.3,"humi":60}
[2026-10-02T06:51:41.658Z] topic=C1/device02/M payload=raw-string-value
```

- 时间戳：接收到消息的 UTC 时间（ISO 8601）
- `topic`：从请求体 `topic` 字段，或请求头 `x-mqtt-topic` / `topic` 取；取不到则省略
- `payload`：对象会被序列化成 JSON 字符串；内部换行会被转义成 `\n`，保证一条消息一行

## 请求体格式兼容

服务对规则引擎发来的 body 做了多种兼容：

1. `{"topic":"C1/xxx/M","payload":{...}}` —— 标准结构
2. `{"topic":"...","payload":"字符串"}` —— payload 为字符串
3. 任意 JSON（没有 `payload` 字段时整体作为 payload，`topic` 从 `topic/Topic/channel` 或请求头推断）
4. 非 JSON 原始文本 —— 整体作为 payload

> 在规则引擎里，建议把「请求体」模板配成 `{"topic":"${topic}","payload":${payload}}`，
> 这样 topic 和业务数据都能被完整记录。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `18339` | 监听端口 |
| `ROUTE_PATH` | `/content` | 接收路由 |
| `LOG_DIR` | `./data` | 日志输出目录 |
| `LOG_PREFIX` | `content` | 日志文件名前缀 |
| `ROTATE_DAILY` | `true` | 是否按天分文件（false 则固定写 `content.txt`） |
| `MAX_BODY_BYTES` | `5242880` | 单请求体最大字节数 |
| `ECHO_CONSOLE` | `true` | 是否同时打印到控制台 |
| `WITH_TIMESTAMP` | `true` | 每行是否带时间戳 |

示例：

```bash
PORT=18339 LOG_DIR=/var/log/mqtt ROTATE_DAILY=false node server.js
```

## 其它接口

- `GET /health` —— 健康检查，返回 `{"status":"ok","uptime":...}`

## 自测

```bash
npm test   # 等价于 node test/selftest.js
```

自测不依赖外部 broker：启动服务 → 模拟发送多种格式消息 → 读回 txt 文件校验内容。
