# Shadowrocket REALITY Fingerprint Override Worker

基于 **Cloudflare Workers** 的轻量订阅适配器：将 3x-ui 订阅中 **VLESS + REALITY** 节点的 `fp=chrome` 定向改为 `fp=chrome140`，以解决部分 Shadowrocket 版本连接新版 Xray-core 时遇到的 TLS ClientHello 兼容性问题。

> **English summary:** A zero-dependency Cloudflare Worker that rewrites `fp=chrome` to `fp=chrome140` in VLESS + REALITY subscription links for Shadowrocket. Supports plain-text and Base64-encoded 3x-ui subscriptions.

## 背景

Xray-core 新版本的 REALITY 实现对 TLS ClientHello 中的 `X25519MLKEM768` key share 有更严格的要求。在部分 Shadowrocket 版本中，通过订阅导入的 `chrome` 指纹预设可能不满足这一要求，导致节点无法连接；手动将指纹改为 `Chrome140` 后则可正常使用。

本项目基于这一实际排障案例：**不修改服务器配置、不回退 Xray-core、不修改 3x-ui 数据库**，而是在订阅返回客户端之前，单独覆写对应的指纹参数。

这是一种针对特定客户端和版本组合的兼容性方案，**不保证所有 Shadowrocket 版本都存在或能通过同样方式解决该问题**。

## 工作原理

```text
Shadowrocket
    |
    | GET https://sub.example.com/subscribe/<SUB_ID>
    v
Cloudflare Worker
    |  GET https://vps.example.com:2096/subscribe/<SUB_ID>
    v
3x-ui 原始订阅
    |
    |  明文 VLESS 链接 / Base64 编码的链接列表
    v
Worker 解码（如有必要）→ 定向覆写 → 重新编码 → 返回 Shadowrocket
```

只修改同时符合以下条件的链接：

- 协议为 `vless://`；
- 查询参数包含 `security=reality`；
- 指纹参数为 `fp=chrome`（不区分大小写）。

例如：

```diff
-vless://UUID@host:443?security=reality&fp=chrome&pbk=...&sid=...#Node
+vless://UUID@host:443?security=reality&fp=chrome140&pbk=...&sid=...#Node
```

其他协议、TLS 参数和节点名称保持不变。Worker **不会修改 TLS 握手本身**；真正发送哪一种 ClientHello，仍由 Shadowrocket 决定。

## 特性

- 零第三方依赖，使用 Cloudflare Workers 原生 JavaScript；
- 同时处理明文订阅和 Base64 编码的 3x-ui 链接列表；
- 仅覆写 VLESS + REALITY 的 `fp=chrome`，避免误伤其他节点；
- 保留上游订阅元数据响应头（例如 `Subscription-Userinfo`）；
- 返回 `X-Fingerprint-Overrides` 响应头，便于确认实际修改数量；
- 对客户端禁用响应缓存，并隐藏回源错误的具体信息。

## 快速部署

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**，新建一个 Worker。
2. 将仓库中的 Worker JavaScript 源码（例如 `worker.js`）粘贴到在线编辑器中。
3. 按下方说明修改代码顶部的 `ORIGIN`、`UPSTREAM_PATH` 和 `ALLOWED_PATH`。
4. 点击 **Deploy**，使用分配的 `*.workers.dev` 地址进行测试。
5. 可选：在 Worker 的 **Settings → Domains & Routes** 添加自定义域名。
6. 在 Shadowrocket 中添加新的 Worker 订阅地址，刷新订阅并测试连接。

### 配置示例

假设你的原始订阅地址为：

```text
https://vps.example.com:2096/subscribe/abc123
```

在 Worker 代码顶部配置：

```javascript
const ORIGIN = 'https://vps.example.com:2096';
const UPSTREAM_PATH = '/subscribe/';
const ALLOWED_PATH = /^\/(?:subscribe)\/([A-Za-z0-9_-]{1,128})\/?$/;
```

Worker 对外地址则为：

```text
https://sub.example.com/subscribe/abc123
```

`ORIGIN` **只包含协议、域名和端口**，不要重复填写订阅路径或订阅 ID。`UPSTREAM_PATH` 指向真实上游订阅目录；`ALLOWED_PATH` 是对外接受的路径正则，并限制订阅 ID 为 1–128 位字母、数字、下划线或连字符。

如果上游使用其他订阅路径，例如 `/subscription_encrypted_URL/`，可以同时改为：

```javascript
const UPSTREAM_PATH = '/subscription_encrypted_URL/';
const ALLOWED_PATH = /^\/subscription_encrypted_URL\/([A-Za-z0-9_-]{1,128})\/?$/;
```

请使用**实际路径**，不要把占位符 `example.com`、`*protected*` 或 Markdown 转义符号直接当成真实配置。

## 验证

部署后，使用 `curl` 检查 Worker 的响应头（将域名和订阅 ID 替换为你自己的）：

```bash
curl -sS -D - -o /dev/null \
  'https://sub.example.com/subscribe/abc123'
```

期望看到类似：

```http
HTTP/2 200
X-Fingerprint-Overrides: 3
```

`X-Fingerprint-Overrides` 大于 `0`，表示至少有一条链接被覆写。若为 `0`，可能是源订阅中没有符合条件的链接，也可能是上游返回了非预期格式。

**最终验收**：在 Shadowrocket 中**重新导入或更新**该订阅，确认节点指纹显示为 `Chrome140`，并实测连接成功。仅有 HTTP 200 或覆写计数大于 0，并不能保证客户端支持这个指纹名称。

### 常见问题

| 现象 | 排查建议 |
| --- | --- |
| `404 Not Found` | 检查对外路径是否匹配 `ALLOWED_PATH`，订阅 ID 是否符合规则。 |
| `502 Subscription origin fetch failed` | 检查 `ORIGIN`、DNS、网络和 HTTPS 证书。 |
| `502 Subscription origin request failed` | 上游返回了非 2xx 状态码；直接测试原始订阅地址。 |
| Cloudflare 530 / 1016 | 通常是上游域名或其源站 DNS 解析问题；先检查 `ORIGIN` 是否填错。 |
| `X-Fingerprint-Overrides: 0` | 检查上游是否真的返回 VLESS + REALITY 的 `fp=chrome` 链接。 |
| Worker 覆写成功，但 Shadowrocket 仍无法连接 | 确认订阅导入后指纹实际显示为 `Chrome140`，并检查客户端版本和其他握手条件。 |

## 兼容性与限制

- **适用范围：** 本方案针对 Shadowrocket 与特定新版 Xray-core 的 REALITY 兼容性问题，需在自己的环境中验证。
- **订阅格式：** 支持明文 VLESS URI 列表和 Base64 编码的 VLESS URI 列表；**不负责解析或重写 Clash YAML、JSON、sing-box 配置**。
- **客户端差异：** `chrome140` 是这里使用的 Shadowrocket 指纹名称，不应不经测试就下发给其他客户端。Mihomo 所用的 `reality-opts.support-x25519mlkem768: true` 是另一种客户端配置方式，不能直接等同于 Shadowrocket 的指纹参数。
- **无额外认证：** Worker 复用原始订阅 ID；不会自动增加鉴权。建议将该 Worker 仅用于自己的订阅，不公开真实订阅链接。
- **不缓存订阅：** 订阅链接可能包含访问凭据。项目设置了 `Cache-Control: private, no-store, max-age=0`，不应额外配置 Cloudflare 缓存规则缓存订阅响应。

## 安全提醒

- **不要提交真实订阅 ID、UUID、REALITY 私钥或有效订阅链接**到公开仓库，也不要在 issue 或截图中泄露它们。
- 代码中的示例域名和路径应使用无效占位符。源站公开域名本身不等于订阅密钥，但公开前仍应核对是否包含敏感信息。
- 如需排障，优先查看 Worker 日志；不要长期向访问者返回详细的源站错误信息。
- 建议仅把 Worker 专用订阅地址交给 Shadowrocket，其他客户端继续使用原始订阅，避免误改其指纹行为。

## 相关资料

- [Xray-core REALITY 指纹兼容性讨论（#7259）](https://github.com/XTLS/Xray-core/issues/7259)
- [Shadowrocket 与新版 Xray-core 的兼容性反馈（#6482）](https://github.com/XTLS/Xray-core/issues/6482)
- [3x-ui 项目](https://github.com/MHSanaei/3x-ui)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

---

本项目是一个最小化的兼容性覆写层，不是 VPN 服务，也不提供代理节点。部署与使用请遵守当地法律法规和相关服务条款。
