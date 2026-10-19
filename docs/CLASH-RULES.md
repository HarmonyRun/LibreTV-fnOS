# Clash 直连规则（解决 STRM 远程播放失败）

## 问题

飞牛影视播放 `.strm` 时，**由客户端直接访问 STRM 里的源站地址**（不走 NAS/中继）。
如果采集站 CDN 域名被 Clash 走了代理，CDN 对代理出口经常返回 **403 / 404**，播放器就会报：

> STRM 直连播放异常，可能原因：网盘挂载连接断开、触发网盘风控、网盘限制非会员操作、浏览器不支持该文件类型。

典型证据：同一 URL 用 NAS（国内直连）访问 200，用 Mac（代理）访问 404。
**解决办法：把这些 CDN 域名和飞牛中继域名设为 DIRECT。**

## 文件

| 文件 | 用途 |
|---|---|
| `clash/rules-snippet.yaml` | 可直接粘贴到 `rules:` 顶部的规则片段 |
| `clash/cms-cdn-direct.yaml` | rule-provider 格式的域名名单（`behavior: domain`） |
| `scripts/collect-cms-cdn.js` | 从默认采集源重新抓取 CDN 域名，更新名单（`node scripts/collect-cms-cdn.js`） |

## 方式一：直接粘贴（推荐，所有 Clash 客户端通用）

打开你的 Clash 配置（Clash Verge Rev：订阅 → 编辑；ClashX Meta：`~/.config/clash/config.yaml`），
把 `clash/rules-snippet.yaml` 中 `rules:` 下的条目复制到 **rules 列表最顶部**
（必须在 `MATCH`、`GEOIP` 或任何 `PROXY` 规则之前，否则不生效）。

```yaml
rules:
  - DOMAIN-SUFFIX,fnos.net,DIRECT
  - DOMAIN-SUFFIX,fnnas.com,DIRECT
  - DOMAIN-SUFFIX,bfikuncdn.com,DIRECT
  # ... 其余见 clash/rules-snippet.yaml ...
  # 原有规则接在后面
  # - GEOIP,CN,DIRECT
  # - MATCH,PROXY
```

保存并重新加载配置。

## 方式二：rule-provider（mihomo / Clash Verge Rev）

把 `clash/cms-cdn-direct.yaml` 放到配置目录（例如 `~/.config/clash/rules/`），然后：

```yaml
rule-providers:
  cms-cdn-direct:
    type: file
    behavior: domain
    path: ./rules/cms-cdn-direct.yaml      # 相对配置文件目录，或写绝对路径

rules:
  - RULE-SET,cms-cdn-direct,DIRECT
  - DOMAIN-SUFFIX,fnos.net,DIRECT
  - DOMAIN-SUFFIX,fnnas.com,DIRECT
  # 原有规则接在后面
```

> 路径按你的客户端调整：Clash Verge Rev 的配置目录通常是
> `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/`。

## 高级：按家族匹配（mihomo 可选）

CDN 会不断换二级域名（`lzcdn27`、`lzcdn28`、`ffzy-play8`…），可在规则中追加正则，
一劳永逸覆盖同家族新域名（取消 `clash/rules-snippet.yaml` 末尾注释即可）：

```yaml
- DOMAIN-REGEX,^(.+\.)?lzcdn\d+\.com$,DIRECT
- DOMAIN-REGEX,^(.+\.)?lz-cdn\d+\.com$,DIRECT
- DOMAIN-REGEX,^(.+\.)?ffzy-(play|online)\d*\.com$,DIRECT
- DOMAIN-REGEX,^(.+\.)?ryplay\d+\.com$,DIRECT
- DOMAIN-REGEX,^(.+\.)?high\d+-playback\.com$,DIRECT
- DOMAIN-REGEX,^(.+\.)?yzzy\d+-play\.com$,DIRECT
```

## 验证

1. 重新加载 Clash 后，在 Clash 面板「连接」里访问该 CDN，应显示 `DIRECT`；
2. 浏览器/手机重新打开影片（或点播放器「重试」）；
3. 仍失败时更换源重新「加入媒体库」，个别 CDN 可能对地区/运营商仍有限制。

## 注意

- 规则只影响**客户端出站**，不改变 NAS 行为，也不会影响局域网/公网其它播放方式；
- `fnos.net`/`fnnas.com` 直连可避免 FN Connect 中继被代理绕行；
- 名单会随采集源变化，建议每隔一段时间重跑 `node scripts/collect-cms-cdn.js` 更新。
