/**
 * 全局按 host 限并发（模块级闸门，跨请求共享）。
 *
 * 使用场景：服务端代替用户向采集站发探测类请求（直播测活 / 画质探测）。
 * 同一运营商的几十个条目常共用一个 host，若只限单请求内的并发，
 * 「多用户 × 单请求并发」会叠加冲击同一弱源，被源站打挂甚至封掉本服务 IP。
 * 同一 host 最多 PER_HOST_CONCURRENCY 个在途请求，不同 host 互不影响；
 * 名额满时 FIFO 排队，空闲闸门及时清理避免 Map 无界增长。
 */

/** 同一 host 允许的最大在途请求数 */
const PER_HOST_CONCURRENCY = 3;

const hostGates = new Map<string, { active: number; waiters: (() => void)[] }>();

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 取一个该 host 的在途名额，返回释放函数；名额满时排队等待 */
export function acquireHostSlot(host: string): Promise<() => void> {
  let gate = hostGates.get(host);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    hostGates.set(host, gate);
  }
  const g = gate;
  return new Promise((resolve) => {
    const take = () => {
      g.active++;
      resolve(() => {
        g.active--;
        // 唤醒的等待者同步接管名额（active-- 后立即 ++），不留被新请求插队的竞态窗口
        const next = g.waiters.shift();
        if (next) next();
        else if (g.active === 0) hostGates.delete(host);
      });
    };
    if (g.active < PER_HOST_CONCURRENCY) take();
    else g.waiters.push(take);
  });
}

/** 在 host 闸门内执行 fn：排队等待的时间不占用 fn 内部的超时预算（超时在 fn 内自行起算） */
export async function withHostLimit<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireHostSlot(hostOf(url));
  try {
    return await fn();
  } finally {
    release();
  }
}
