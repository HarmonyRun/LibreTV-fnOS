export type RecommendSourceValue = 'douban' | 'bangumi' | 'hot-list';

/**
 * 部署者通过 DEFAULT_RECOMMEND_SOURCE 环境变量指定的首页推荐数据源默认值。
 * 可选值：douban（豆瓣热门）/ bangumi（Bangumi 新番放送）/ hot-list（影视热榜）。
 * 未配置返回 undefined（沿用内置默认 hot-list）；取值非法时告警并忽略，不影响站点运行。
 */
export function getEnvRecommendSource(): RecommendSourceValue | undefined {
  const raw = process.env.DEFAULT_RECOMMEND_SOURCE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'douban' || raw === 'bangumi' || raw === 'hot-list') return raw;
  console.warn(
    '[LibreTV] DEFAULT_RECOMMEND_SOURCE 取值无效，已忽略（可选 douban / bangumi / hot-list）：',
    raw
  );
  return undefined;
}
