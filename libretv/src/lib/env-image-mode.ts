export type ImageModeValue = 'direct' | 'proxy';

/**
 * 部署者通过 DEFAULT_IMAGE_MODE 环境变量指定的封面图加载方式默认值。
 * 可选值：direct（原站直连优先，省服务器流量）/ proxy（内置代理优先，最稳定）。
 * 不开放 custom——自定义代理模板是每用户手填的本地配置，没有全局模板可下发，
 * 强设 custom 只会让未填模板的用户静默退化为直连。
 * 未配置返回 undefined（沿用内置默认 direct）；取值非法时告警并忽略，不影响站点运行。
 */
export function getEnvImageMode(): ImageModeValue | undefined {
  const raw = process.env.DEFAULT_IMAGE_MODE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'direct' || raw === 'proxy') return raw;
  console.warn(
    '[LibreTV] DEFAULT_IMAGE_MODE 取值无效，已忽略（可选 direct / proxy）：',
    raw
  );
  return undefined;
}
