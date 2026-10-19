const sources = [
  'https://caiji.dyttzyapi.com/api.php/provide/vod',
  'https://cj.lziapi.com/api.php/provide/vod',
  'https://cj.rycjapi.com/api.php/provide/vod',
  'https://api.yzzy-api.com/inc/apijson.php',
  'https://api.ffzyapi.com/api.php/provide/vod',
  'https://cj.ffzyapi.com/api.php/provide/vod',
  'https://api.1080zyku.com/inc/apijson.php',
  'https://api.tiankongapi.com/api.php/provide/vod',
  'https://json.heimuer.xyz/api.php/provide/vod',
  'https://api.wujinapi.com/api.php/provide/vod',
  'https://cj.ukuapi.com/api.php/provide/vod',
  'https://api.zuidapi.com/api.php/provide/vod',
  'https://api.maoyanapi.top/api.php/provide/vod',
  'https://www.hongniuzy2.com/api.php/provide/vod',
  'https://jszyapi.com/api.php/provide/vod',
  'https://ikunzyapi.com/api.php/provide/vod',
];
const titles = ['沙丘','庆余年','流浪地球','狂飙','甄嬛传'];
const hosts = new Map();
function addHost(u){
  try{
    const h = new URL(u).hostname.toLowerCase();
    if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h==='localhost') return;
    // 取最后两段作为可匹配后缀（简单域名场景足够）
    const parts = h.split('.');
    const suffix = parts.length >= 2 ? parts.slice(-2).join('.') : h;
    hosts.set(suffix, (hosts.get(suffix)||0)+1);
  }catch(e){}
}
(async()=>{
  for(const api of sources){
    for(const t of titles){
      try{
        const s=await fetch(`${api}?ac=videolist&wd=${encodeURIComponent(t)}&pg=1`,{signal:AbortSignal.timeout(8000)}).then(r=>r.json());
        const list=s.list||[];
        for(const item of list.slice(0,1)){
          const d=await fetch(`${api}?ac=videolist&ids=${item.vod_id}`,{signal:AbortSignal.timeout(8000)}).then(r=>r.json());
          const v=(d.list||[])[0]; if(!v) continue;
          for(const line of (v.vod_play_url||'').split('$$$'))
            for(const ep of line.split('#')){
              const u=ep.split('$').slice(1).join('$');
              if(/^https?:\/\//i.test(u)) addHost(u);
            }
        }
      }catch(e){}
    }
  }
  const sorted=[...hosts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  console.log('count',sorted.length);
  for(const [h,c] of sorted) console.log(h,c);
})();
