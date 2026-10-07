// ==UserScript==
// @name         夸克网盘批量转存助手
// @namespace    quark-batch-save
// @version      0.1.0
// @description  自动分批转存夸克分享（每批≤300文件），保留目录结构，失败批次可重试/拆半重试
// @match        https://pan.quark.cn/s/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      drive-pc.quark.cn
// ==/UserScript==

(function () {
  'use strict';

  /* ==================== 配置 ==================== */
  const API = 'https://drive-pc.quark.cn/1/clouddrive'; // 夸克 PC 网页端接口基址
  const COMMON = 'pr=ucpro&fr=pc';                      // 网页端固定查询参数
  const DEFAULT_BATCH = 200;  // 每批最大文件数（含文件夹内文件，官方上限500，留余量）
  const PAGE_SIZE = 50;       // 文件列表分页大小（夸克服务端实际每页固定 50，请求更大也会被截断）
  const REQ_GAP = 350;        // 相邻请求最小间隔(ms)，避免触发风控
  const TASK_TIMEOUT = 120;   // 单批转存任务轮询上限(秒)

  /* ==================== 运行时状态 ==================== */
  const S = {
    pwdId: (location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || '',
    stoken: '',
    tree: null,               // 扫描出的分享目录树
    batches: [],              // 分批转存计划
    plannedKey: '',           // 规划指纹：树+每批数量，防止误重置进度
    running: false,
    stats: { files: 0, dirs: 0 },
  };
  const dirCache = new Map(); // 目标网盘相对路径 -> fid（断点续跑时复用已建目录）

  /* ==================== 基础工具 ==================== */

  /**
   * 按需限速：保证相邻请求间隔不小于 REQ_GAP
   */
  async function gap() {
    const wait = gap.last + REQ_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    gap.last = Date.now();
  }
  gap.last = 0;

  /**
   * sleep 毫秒
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 请求夸克接口：JSON in/out，自动带 cookie；status=200 且 code=0 视为成功
   */
  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://pan.quark.cn/' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 30000,
        onload: (r) => {
          let j = null;
          try { j = JSON.parse(r.responseText); }
          catch (e) { return reject(new Error(`非JSON响应(HTTP ${r.status})`)); }
          if (j.status === 200 && (j.code === 0 || j.code === '0')) return resolve(j.data ?? {});
          reject(new Error(`[${j.status}/${j.code}] ${j.message || j.error_msg || '接口报错'}`));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  /* ==================== 分享侧 API ==================== */

  /**
   * 获取分享 stoken；带提取码的分享需先在面板填码
   */
  async function fetchToken(passcode) {
    const d = await req('POST', `${API}/share/sharepage/token?${COMMON}`, {
      pwd_id: S.pwdId, passcode: passcode || '',
    });
    if (!d.stoken) throw new Error('未获取到 stoken：' + JSON.stringify(d));
    return d.stoken;
  }

  /**
   * 从 URL 参数提取提取码（夸克部分分享链接带 ?pwd=xxxx）
   */
  function getPasscodeFromUrl() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get('pwd') || p.get('passcode') || p.get('code') || '';
    } catch (e) { return ''; }
  }

  /**
   * 从页面 DOM 提取用户已输入的提取码：遍历 input 找 4 位字母数字值
   */
  function getPasscodeFromDom() {
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      const v = (inp.value || '').trim();
      if (/^[a-zA-Z0-9]{4}$/.test(v)) return v;
    }
    return '';
  }

  /**
   * 从页面 JS 上下文提取已有的 stoken（用户已在页面输入过提取码时，页面内存中有 stoken）。
   * 油猴脚本运行在 isolated world，需注入 script 到页面上下文执行后通过 DOM 回传。
   */
  function getStokenFromPage() {
    return new Promise((resolve) => {
      // 桥接元素：页面 script 写入，油猴脚本读取
      let bridge = document.getElementById('qbs-page-bridge');
      if (!bridge) {
        bridge = document.createElement('div');
        bridge.id = 'qbs-page-bridge';
        bridge.style.display = 'none';
        document.body.appendChild(bridge);
      }
      bridge.setAttribute('data-stoken', '');
      const script = document.createElement('script');
      // 递归在对象中查找 stoken 字段；限制深度避免爆栈
      script.textContent = `
        (function(){
          function find(o,d){
            if(!o||d>10||typeof o!=='object')return null;
            try{
              if(typeof o.stoken==='string'&&o.stoken)return o.stoken;
              for(var k in o){
                if(k==='window'||k==='document'||k==='self'||k==='top'||k==='parent')continue;
                try{
                  var v=o[k];
                  if(v&&typeof v==='object'){var r=find(v,d+1);if(r)return r;}
                }catch(e){}
              }
            }catch(e){}
            return null;
          }
          var s=null;
          try{s=find(window.__NUXT__,0);}catch(e){}
          if(!s){try{s=find(window.__INITIAL_STATE__,0);}catch(e){}}
          if(!s){try{s=find(window.$nuxt&&window.$nuxt.$store&&window.$nuxt.$store.state,0);}catch(e){}}
          if(!s){
            try{
              for(var k in window){
                if(/nuxt|store|state|share|token/i.test(k)){
                  try{var r=find(window[k],0);if(r){s=r;break;}}catch(e){}
                }
              }
            }catch(e){}
          }
          var b=document.getElementById('qbs-page-bridge');
          if(b)b.setAttribute('data-stoken',s||'');
        })();
      `;
      document.body.appendChild(script);
      script.remove();
      setTimeout(() => resolve((bridge.getAttribute('data-stoken') || '').trim()), 80);
    });
  }

  /**
   * 自动获取 stoken：依次尝试 页面全局变量 → 无提取码接口 → URL提取码 → DOM提取码
   * 全部失败返回空串，由调用方提示用户手动输入
   */
  async function autoAuth() {
    // 1. 用户已在页面输入过提取码 → 直接从页面内存拿 stoken
    const pageStoken = await getStokenFromPage();
    if (pageStoken) return pageStoken;
    // 2. 无提取码分享
    try { return await fetchToken(''); } catch (e) {}
    // 3. URL 带提取码
    const urlPwd = getPasscodeFromUrl();
    if (urlPwd) { try { return await fetchToken(urlPwd); } catch (e) {} }
    // 4. 页面输入框里的提取码
    const domPwd = getPasscodeFromDom();
    if (domPwd) { try { return await fetchToken(domPwd); } catch (e) {} }
    return '';
  }

  /**
   * 按文件-文件夹语义判断条目类型（不再用 file_type 数字猜）：
   * - dir 布尔字段优先（share/detail 与 file/sort 都返回，最可靠）
   * - 否则看 file 字段：仅文件有值（如扩展名），空为文件夹（file/sort）
   * - 否则看 file_type：文件夹为 0/空，非 0 是文件分类码（1=视频 2=音频…，与是否文件夹无关）
   */
  const isDirOf = (it) => {
    if (typeof it.dir === 'boolean') return it.dir;
    if (typeof it.file === 'string') return !it.file;
    return !Number(it.file_type);
  };

  /**
   * 列出分享内某目录的一页文件；返回 {list, total}：
   * list 含 fid/share_fid_token/dir/file_type/file_name，total 为该目录条目总数
   */
  async function listShareDir(pdirFid, page) {
    const q = `${COMMON}&pwd_id=${encodeURIComponent(S.pwdId)}&stoken=${encodeURIComponent(S.stoken)}` +
      `&pdir_fid=${encodeURIComponent(pdirFid)}&_page=${page}&_size=${PAGE_SIZE}` +
      `&_fetch_banner=0&_fetch_share=0&_fetch_total=1&_sort="file_type:asc,file_name:asc"`;
    const d = await req('GET', `${API}/share/sharepage/detail?${q}`);
    return {
      list: d.list || [],
      total: d.metadata ? Number(d.metadata._total || 0) : 0,
    };
  }

  /**
   * 递归扫描分享全目录（BFS），构建树并统计文件/目录数；
   * 分页以接口返回的 total 为准（服务端页大小可能小于请求值），total 缺失时退化为空页停止
   */
  async function scanTree(onProgress) {
    const root = { fid: '0', token: '', name: '', isDir: true, children: [] };
    const queue = [root];
    let files = 0, dirs = 0;
    while (queue.length) {
      const dir = queue.shift();
      let page = 1, seen = 0;
      for (;;) {
        await gap();
        const { list, total } = await listShareDir(dir.fid, page);
        if (!list.length) break;
        if (files + dirs === 0) console.log('[夸克转存助手] 首条目原始字段（字段语义变化时供排查）:', JSON.stringify(list[0]).slice(0, 500));
        for (const it of list) {
          const isDir = isDirOf(it);
          const node = { fid: it.fid, token: it.share_fid_token, name: it.file_name, isDir, children: isDir ? [] : null };
          dir.children.push(node);
          if (isDir) { dirs++; queue.push(node); } else { files++; }
        }
        seen += list.length;
        if (total > 0 ? seen >= total : list.length < PAGE_SIZE) break;
        page++;
        if (page > 500) break; // ponytail: 保险丝，单目录2.5万条封顶；超限目录现实中不存在
      }
      onProgress && onProgress(files, dirs, queue.length);
    }
    return { root, files, dirs };
  }

  /* ==================== 我的网盘侧 API ==================== */

  /**
   * 列出自己网盘某目录一页条目；返回 {list, total}
   */
  async function listMyDir(pdirFid, page) {
    const q = `${COMMON}&pdir_fid=${encodeURIComponent(pdirFid)}&_page=${page}&_size=${PAGE_SIZE}` +
      `&_fetch_total=1&_sort="file_type:asc,file_name:asc"`;
    const d = await req('GET', `${API}/file/sort?${q}`);
    return {
      list: d.list || [],
      total: d.metadata ? Number(d.metadata._total || 0) : 0,
    };
  }

  /**
   * 在自己网盘某目录下查找同名子目录，返回其 fid（找不到返回 null）；
   * 分页以 total 为准，避免服务端截断每页导致提前误判"不存在"
   */
  async function findChildDir(pdirFid, name) {
    for (let page = 1, seen = 0; page <= 100; page++) {
      await gap();
      const { list, total } = await listMyDir(pdirFid, page);
      if (!list.length) return null;
      const hit = list.find((it) => isDirOf(it) && it.file_name === name);
      if (hit) return hit.fid;
      seen += list.length;
      if (total > 0 ? seen >= total : list.length < PAGE_SIZE) return null;
    }
    return null;
  }

  /**
   * 在自己网盘某目录下新建子目录，返回新目录 fid
   */
  async function mkdir(pdirFid, name) {
    const d = await req('POST', `${API}/file?${COMMON}`, {
      pdir_fid: pdirFid, file_name: name, dir_path: '', dir_init_lock: false,
    });
    if (!d.fid) throw new Error('建目录失败：' + JSON.stringify(d));
    return d.fid;
  }

  /**
   * 确保目标网盘中存在相对路径对应的目录链，返回末级 fid（带缓存，支持断点续跑）
   */
  async function ensureDir(relPath) {
    if (dirCache.has(relPath)) return dirCache.get(relPath);
    const parts = relPath ? String(relPath).split('/').filter(Boolean) : [];
    let fid = '0';
    let cur = '';
    for (const name of parts) {
      cur = cur ? `${cur}/${name}` : name;
      if (dirCache.has(cur)) { fid = dirCache.get(cur); continue; }
      await gap();
      // 先查重名再创建：重跑/中断续传时直接复用已建好的目录
      let next = await findChildDir(fid, name);
      if (!next) next = await mkdir(fid, name);
      fid = next;
      dirCache.set(cur, fid);
    }
    return fid;
  }

  /* ==================== 目标侧比对（去重） ==================== */

  // 目标网盘目录内容缓存：fid -> Map<name, {isDir, fid}>
  // ponytail: 单次运行内有效，不做持久化；内存上限为已访问目录数 × 单目录条目数
  const targetCache = new Map();

  /**
   * 加载目标网盘某目录下全部子条目（遍历分页），返回 Map<name, {isDir, fid}>（带缓存）
   * fid 为 null 时表示目标侧此目录不存在，返回空 Map
   */
  async function loadTargetDir(fid) {
    if (!fid) return new Map();
    if (targetCache.has(fid)) return targetCache.get(fid);
    const map = new Map();
    for (let page = 1, seen = 0; page <= 100; page++) {
      await gap();
      const { list, total } = await listMyDir(fid, page);
      if (!list.length) break;
      for (const it of list) map.set(it.file_name, { isDir: isDirOf(it), fid: it.fid });
      seen += list.length;
      if (total > 0 ? seen >= total : list.length < PAGE_SIZE) break;
    }
    targetCache.set(fid, map);
    return map;
  }

  /**
   * 把 items 列表按 batchSize（递归节点数上限）拆成多个批次。
   * 夸克对文件夹会递归转存，所以单个文件夹的权重是其递归节点数。
   * 单个 item 的节点数若超过 batchSize，调用方应已先下钻处理，此处不再拆分单个 item。
   */
  function splitItems(items, relPath, srcPdirFid, batchSize) {
    const batches = [];
    let curItems = [], curLeaves = 0, curNodes = 0;
    for (const item of items) {
      const w = countNodes(item);
      if (curItems.length && curNodes + w > batchSize) {
        batches.push({ relPath, srcPdirFid, items: curItems, leaves: curLeaves });
        curItems = []; curLeaves = 0; curNodes = 0;
      }
      curItems.push(item);
      curNodes += w;
      curLeaves += item.isDir ? countLeaves(item) : 1;
    }
    if (curItems.length) batches.push({ relPath, srcPdirFid, items: curItems, leaves: curLeaves });
    return batches;
  }

  /**
   * 递归对比分享侧文件夹与目标侧同名文件夹，返回需要转存的批次列表。
   * - 子文件同名已存在 → 跳过
   * - 子文件夹同名已存在 → 递归深入
   * - 子文件夹不存在且叶子数 ≤ batchSize → 整体作为 item 转存
   * - 子文件夹不存在但叶子数 > batchSize → 下钻展开（targetFid 传 null，所有子项直接转存）
   * 返回的批次均按 batchSize 拆分，relPath 已包含完整相对路径。
   */
  async function diffFolder(srcDir, targetFid, baseRelPath, batchSize) {
    const existing = await loadTargetDir(targetFid);
    const directItems = []; // 当前层级可直接转存的 items（目标路径 = baseRelPath）
    const batches = [];
    for (const child of srcDir.children) {
      const hit = existing.get(child.name);
      if (child.isDir) {
        if (hit && hit.isDir) {
          // 同名文件夹已存在 → 递归深入，缺失子项的 relPath 加上该层
          const subBatches = await diffFolder(child, hit.fid, baseRelPath ? `${baseRelPath}/${child.name}` : child.name, batchSize);
          batches.push(...subBatches);
        } else if (countNodes(child) > batchSize) {
          // 文件夹不存在但递归节点数超限 → 下钻展开（目标侧无此目录，子项全部直接转存）
          const subBatches = await diffFolder(child, null, baseRelPath ? `${baseRelPath}/${child.name}` : child.name, batchSize);
          batches.push(...subBatches);
        } else {
          // 文件夹不存在且不超限 → 整体转存
          directItems.push(child);
        }
      } else {
        // 文件：同名已存在则跳过
        if (hit && !hit.isDir) continue;
        directItems.push(child);
      }
    }
    // 按 batchSize 拆分当前层的直接转存项，避免单次 save 超限
    batches.push(...splitItems(directItems, baseRelPath, srcDir.fid, batchSize));
    return batches;
  }

  /**
   * 对单个批次做去重过滤：
   * - 文件同名已存在 → 跳过
   * - 文件夹同名已存在 → 深入比对，把缺失子项展开为新批次插入队列
   * - 文件夹不存在 → 整体保留转存
   * 返回当前批次过滤后是否还有剩余项。
   */
  async function dedupBatch(b) {
    const toFid = await ensureDir([destPrefix(), b.relPath].filter(Boolean).join('/'));
    const existing = await loadTargetDir(toFid);
    const batchSize = Math.max(1, Math.min(500, Number(document.getElementById('qbs-size').value) || DEFAULT_BATCH));
    const kept = [];
    const extraBatches = [];
    for (const item of b.items) {
      const hit = existing.get(item.name);
      if (item.isDir) {
        if (hit && hit.isDir) {
          // 同名文件夹已存在 → 深入比对，缺失子项展开为新批次（已按 batchSize 拆分）
          const subBatches = await diffFolder(item, hit.fid, b.relPath ? `${b.relPath}/${item.name}` : item.name, batchSize);
          extraBatches.push(...subBatches);
        } else {
          kept.push(item);
        }
      } else {
        if (hit && !hit.isDir) continue;
        kept.push(item);
      }
    }
    b.items = kept;
    b.leaves = kept.reduce((s, i) => s + (i.isDir ? countLeaves(i) : 1), 0);
    // 展开的新批次插入到当前批次之后，relPath 已含完整路径
    if (extraBatches.length) {
      const idx = S.batches.indexOf(b);
      const newBatches = extraBatches.map((nb) => ({ ...nb, status: 'pending', error: '' }));
      S.batches.splice(idx + 1, 0, ...newBatches);
    }
    return kept.length > 0;
  }

  /**
   * 读取去重开关状态
   */
  function dedupEnabled() {
    const el = document.getElementById('qbs-dedup');
    return el ? el.checked : true;
  }

  /* ==================== 分批算法（纯逻辑，无 IO） ==================== */

  /**
   * 统计目录树下文件总数（叶子数），用于显示"共 N 个文件"
   */
  function countLeaves(node) {
    if (!node.isDir) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  /**
   * 统计目录树递归节点总数（文件+文件夹），用于批次大小限制。
   * 夸克 save 接口对文件夹会递归转存，限制的是展开后的总节点数。
   */
  function countNodes(node) {
    if (!node.isDir) return 1;
    return 1 + node.children.reduce((s, c) => s + countNodes(c), 0);
  }

  /**
   * 生成分批计划：同目录子项贪心装箱，装满即出一批。
   * 批次大小按递归节点数限制（文件+文件夹，夸克对文件夹会递归转存）；
   * 单个文件夹节点数超限时下钻到子级拆分。
   * ponytail: 朴素贪心而非最优装箱，批次数可能略多，但实现简单且能处理任意超大树
   */
  function planBatches(root, batchSize) {
    const out = [];
    /**
     * 遍历某目录的子项装箱；batch 的递归节点数达上限则 flush
     */
    function walk(children, relPath, srcPdirFid) {
      let cur = null;
      const newBatch = () => ({ relPath, srcPdirFid, items: [], leaves: 0, nodes: 0, status: 'pending', error: '' });
      const flush = () => { if (cur && cur.items.length) out.push(cur); cur = null; };
      for (const child of children) {
        const w = countNodes(child);
        // 超大文件夹：递归节点数超限 → 下钻到子级
        if (child.isDir && w > batchSize) {
          flush();
          const rp = relPath ? `${relPath}/${child.name}` : child.name;
          walk(child.children, rp, child.fid);
          continue;
        }
        if (!cur) cur = newBatch();
        if (cur.nodes + w > batchSize) { flush(); cur = newBatch(); }
        cur.items.push(child);
        cur.nodes += w;
        cur.leaves += child.isDir ? countLeaves(child) : 1;
      }
      flush();
    }
    walk(root.children, '', root.fid);
    return out;
  }

  /* ==================== 转存执行 ==================== */

  /**
   * 读取用户填写的目标路径，归一化为无首尾斜杠的相对路径段（"/" 或空 = 根目录）
   */
  function destPrefix() {
    const v = (document.getElementById('qbs-dest').value || '/').trim();
    return v.replace(/^\/+|\/+$/g, '');
  }

  /**
   * 转存一批：先去重（开关开启时）→ 定位/创建目标目录 → 发起转存 → 轮询任务直到完成
   */
  async function runBatch(b) {
    // 重试场景下也做去重：批次可能部分已转存成功，跳过已存在的防止重复
    if (dedupEnabled()) {
      const hasItems = await dedupBatch(b);
      if (!hasItems) return true; // 全部已存在，视为成功
    }
    const toFid = await ensureDir([destPrefix(), b.relPath].filter(Boolean).join('/'));
    await gap();
    const d = await req('POST', `${API}/share/sharepage/save?${COMMON}`, {
      fid_list: b.items.map((i) => i.fid),
      fid_token_list: b.items.map((i) => i.token),
      to_pdir_fid: toFid,
      pwd_id: S.pwdId,
      stoken: S.stoken,
      pdir_fid: b.srcPdirFid,
      scene: 'link',
    });
    if (d.task_id == null) return true; // 部分版本同步返回即成功
    return pollTask(d.task_id);
  }

  /**
   * 轮询转存任务直至完成/失败/超时；轮询中的网络抖动按超时处理而非立刻失败
   */
  async function pollTask(taskId) {
    const deadline = Date.now() + TASK_TIMEOUT * 1000;
    let retry = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      retry++;
      let t = null;
      try {
        t = await req('GET', `${API}/task?${COMMON}&task_id=${taskId}&retry_index=${retry}`);
      } catch (e) { continue; } // 单次查询失败不致命，继续轮询直到超时
      const st = Number(t.status);
      if (st === 2) return true;                       // 任务成功
      if (t.save_as && t.save_as.ended) return true;   // 兼容字段判定
      if (st > 2) throw new Error(`转存任务失败(status=${st})：${t.message || t.task_title || ''}`);
    }
    throw new Error('任务超时未完成，请稍后人工核对结果后再决定是否重试');
  }

  /**
   * 顺序执行全部未成功批次：单批失败不中断整体，最后汇总
   */
  async function runAll() {
    const todo = S.batches.filter((b) => b.status !== 'ok');
    let ok = 0, fail = 0;
    for (let i = 0; i < S.batches.length; i++) {
      const b = S.batches[i];
      if (b.status === 'ok') { ok++; continue; }
      b.status = 'running'; b.error = '';
      renderBatches();
      try {
        await runBatch(b);
        b.status = 'ok'; ok++;
      } catch (e) {
        b.status = 'failed'; b.error = e.message; fail++;
      }
      renderBatches();
      setStatus(`转存进度：${ok + fail}/${todo.length} 批完成（成功 ${ok}，失败 ${fail}）`);
    }
    const savedFiles = S.batches.filter((b) => b.status === 'ok').reduce((s, b) => s + b.leaves, 0);
    setStatus(fail
      ? `完成：成功 ${ok} 批，失败 ${fail} 批。可对失败批次重试或拆半重试。`
      : `全部完成：${ok} 批转存成功，共 ${savedFiles} 个文件已保存到目标路径。`);
  }

  /**
   * 重试单个批次及其去重时展开的后续批次
   * （dedupBatch 可能把目标侧已存在的同名文件夹展开为多个新批次插入到当前批次之后）
   */
  async function rerunBatch(b) {
    if (S.running || b.status === 'ok') return;
    S.running = true;
    setBusy(true);
    const startIdx = S.batches.indexOf(b);
    try {
      for (let i = startIdx; i < S.batches.length; i++) {
        const cur = S.batches[i];
        if (cur.status === 'ok') continue;
        cur.status = 'running'; cur.error = '';
        renderBatches();
        try { await runBatch(cur); cur.status = 'ok'; }
        catch (e) { cur.status = 'failed'; cur.error = e.message; }
        renderBatches();
      }
    } finally {
      S.running = false;
      setBusy(false);
    }
  }

  /**
   * 拆半重试：把失败批次一分为二（目标路径不变），原批次被替换成两个新批次
   */
  function splitBatch(b) {
    if (b.items.length < 2) return false;
    const idx = S.batches.indexOf(b);
    const mk = (items) => ({
      relPath: b.relPath, srcPdirFid: b.srcPdirFid, items,
      leaves: items.reduce((s, i) => s + (i.isDir ? countLeaves(i) : 1), 0),
      status: 'pending', error: '',
    });
    const mid = Math.ceil(b.items.length / 2);
    S.batches.splice(idx, 1, mk(b.items.slice(0, mid)), mk(b.items.slice(mid)));
    return true;
  }

  /* ==================== UI ==================== */

  /**
   * 创建并注入控制面板（原生 DOM，无依赖）
   */
  function buildUI() {
    const css = `
      #qbs-panel{position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;
        background:#1f2430;color:#e8eaf0;font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
        border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden}
      #qbs-panel .qbs-head{padding:8px 12px;background:#2b3245;font-weight:600;cursor:pointer;user-select:none}
      #qbs-panel .qbs-min{float:right;opacity:.6}
      #qbs-panel .qbs-body{padding:10px 12px;max-height:70vh;overflow:auto}
      #qbs-panel.qbs-folded .qbs-body{display:none}
      #qbs-panel .qbs-row{margin:6px 0;display:flex;align-items:center;gap:6px}
      #qbs-panel input{flex:1;min-width:0;padding:4px 6px;border:1px solid #3a4358;border-radius:6px;
        background:#141925;color:#e8eaf0}
      #qbs-panel button{padding:4px 10px;border:0;border-radius:6px;background:#4c6ef5;color:#fff;
        cursor:pointer;white-space:nowrap}
      #qbs-panel button:hover{background:#6d8bff}
      #qbs-panel button:disabled{background:#3a4358;cursor:not-allowed}
      #qbs-panel .qbs-status{margin:6px 0;padding:6px 8px;background:#141925;border-radius:6px;
        min-height:18px;word-break:break-all}
      #qbs-panel .qbs-batch{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;margin:2px 0}
      #qbs-panel .qbs-batch .qbs-lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #qbs-panel .qbs-batch.ok{color:#69db7c}
      #qbs-panel .qbs-batch.failed{color:#ff8787}
      #qbs-panel .qbs-batch.running{color:#ffd43b}
      #qbs-panel .qbs-batch.pending{color:#adb5bd}
      #qbs-panel .qbs-batch button{padding:1px 8px;font-size:11px;background:#495057}
      #qbs-batches{margin-top:8px;max-height:260px;overflow:auto}
      /* 目录浏览器弹窗 */
      #qbs-browser{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);
        display:none;align-items:center;justify-content:center}
      #qbs-browser.show{display:flex}
      #qbs-browser .qbs-br-box{width:460px;max-width:92vw;background:#1f2430;color:#e8eaf0;
        font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;border-radius:10px;
        box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
      #qbs-browser .qbs-br-head{padding:10px 14px;background:#2b3245;font-weight:600;
        display:flex;justify-content:space-between;align-items:center}
      #qbs-browser .qbs-br-close{cursor:pointer;opacity:.6;user-select:none}
      #qbs-browser .qbs-br-close:hover{opacity:1}
      #qbs-browser .qbs-br-body{padding:10px 14px;max-height:60vh;overflow:auto}
      #qbs-browser .qbs-br-crumb{margin-bottom:8px;word-break:break-all;font-size:11px}
      #qbs-browser .qbs-br-crumb span{cursor:pointer;color:#74c0fc}
      #qbs-browser .qbs-br-crumb span:hover{text-decoration:underline}
      #qbs-browser .qbs-br-crumb .qbs-sep{color:#6c757d;margin:0 4px;cursor:default;text-decoration:none}
      #qbs-browser .qbs-br-dir{padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;
        align-items:center;gap:8px}
      #qbs-browser .qbs-br-dir:hover{background:#2b3245}
      #qbs-browser .qbs-br-dir .qbs-ic{color:#ffd43b}
      #qbs-browser .qbs-br-actions{padding:10px 14px;background:#141925;display:flex;gap:8px}
      #qbs-browser button{padding:6px 14px;border:0;border-radius:6px;cursor:pointer;
        font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
      #qbs-browser .qbs-br-select{background:#4c6ef5;color:#fff}
      #qbs-browser .qbs-br-select:hover{background:#6d8bff}
      #qbs-browser .qbs-br-new{background:#495057;color:#fff}
      #qbs-browser .qbs-br-new:hover{background:#5c636a}
      #qbs-browser .qbs-br-empty{padding:20px 8px;text-align:center;color:#6c757d}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'qbs-panel';
    panel.innerHTML = `
      <div class="qbs-head">夸克批量转存助手<span class="qbs-min">收起</span></div>
      <div class="qbs-body">
        <div class="qbs-row">提取码 <input id="qbs-code" placeholder="无码分享留空">
          <button id="qbs-token">授权</button></div>
        <div class="qbs-status" id="qbs-status">初始化中…</div>
        <div class="qbs-row"><button id="qbs-scan" style="flex:1">① 扫描目录结构</button></div>
        <div class="qbs-row">目标路径 <input id="qbs-dest" value="/" title="保存到我的网盘的路径，如 /转存合集">
          <button id="qbs-browse" title="浏览我的网盘选择目标目录">浏览</button></div>
        <div class="qbs-row">每批数量 <input id="qbs-size" type="number" min="1" max="500" value="${DEFAULT_BATCH}"></div>
        <div class="qbs-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="qbs-dedup" checked style="flex:none;width:auto">
          比对去重（跳过目标网盘已存在的文件）</label></div>
        <div class="qbs-row"><button id="qbs-run" style="flex:1">② 开始转存</button></div>
        <div class="qbs-row"><button id="qbs-retry">重试未完成</button>
          <button id="qbs-export">导出结构JSON</button></div>
        <div id="qbs-batches"></div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.qbs-head').addEventListener('click', () => {
      panel.classList.toggle('qbs-folded');
    });

    document.getElementById('qbs-token').addEventListener('click', async () => {
      try {
        setStatus('获取访问权限…');
        S.stoken = await fetchToken(document.getElementById('qbs-code').value.trim());
        setStatus(`已获取访问权限（pwd_id=${S.pwdId}），可开始扫描。`);
      } catch (e) { setStatus('授权失败：' + e.message + '（带码分享请填提取码；未登录请先登录网盘）'); }
    });

    document.getElementById('qbs-scan').addEventListener('click', async () => {
      if (S.running) return;
      if (!S.stoken) return setStatus('请先点击「授权」获取访问权限。');
      try {
        setStatus('扫描目录结构中…');
        const { root, files, dirs } = await scanTree((f, d, pending) =>
          setStatus(`扫描中：已发现 ${f} 个文件 / ${d} 个文件夹，待扫描文件夹 ${pending}…`));
        S.tree = root;
        S.stats = { files, dirs };
        S.batches = [];
        S.plannedKey = '';
        replan();
      } catch (e) { setStatus('扫描失败：' + e.message); }
    });

    document.getElementById('qbs-run').addEventListener('click', async () => {
      if (S.running) return;
      if (!S.tree) return setStatus('请先扫描目录结构。');
      if (!S.stoken) return setStatus('请先授权。');
      const size = Math.max(1, Math.min(500, Number(document.getElementById('qbs-size').value) || DEFAULT_BATCH));
      // 已有进度时改批量会重置全部状态 → 必须用户确认，防止重复转存
      if (S.batches.length && S.plannedKey !== planKey(size) &&
          S.batches.some((b) => b.status === 'ok') &&
          !confirm('修改每批数量将重新规划并清空已有进度，可能造成重复转存。确定继续？')) return;
      // 去重改为分批执行：每个批次转存前由 runBatch 内的 dedupBatch 处理，
      // 避免启动时一次性扫描整棵树造成的长时间等待
      replan(size);
      S.running = true;
      setBusy(true);
      try { await runAll(); }
      finally { S.running = false; setBusy(false); }
    });

    document.getElementById('qbs-retry').addEventListener('click', async () => {
      if (S.running) return;
      const todo = S.batches.filter((b) => b.status !== 'ok');
      if (!todo.length) return setStatus('没有需要重试的批次。');
      S.running = true;
      setBusy(true);
      try { await runAll(); }
      finally { S.running = false; setBusy(false); }
    });

    document.getElementById('qbs-export').addEventListener('click', exportJSON);

    document.getElementById('qbs-browse').addEventListener('click', openBrowser);
  }

  /**
   * 更新面板状态文本
   */
  function setStatus(msg) {
    const el = document.getElementById('qbs-status');
    if (el) el.textContent = msg;
  }

  /**
   * 运行期间禁用主要按钮
   */
  function setBusy(busy) {
    ['qbs-scan', 'qbs-run', 'qbs-retry', 'qbs-token'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = busy;
    });
  }

  /**
   * 规划指纹：树引用 + 每批数量（用于检测是否需要重置进度）
   */
  function planKey(size) { return `${S.tree ? 'tree' : ''}:${size}`; }

  /**
   * （重新）生成分批计划并刷新列表
   */
  function replan(size) {
    size = size || Math.max(1, Math.min(500, Number(document.getElementById('qbs-size').value) || DEFAULT_BATCH));
    S.batches = planBatches(S.tree, size);
    S.plannedKey = planKey(size);
    renderBatches();
    const files = countLeaves(S.tree);
    setStatus(`共 ${files} 个文件待转存，将分 ${S.batches.length} 批转存（每批 ≤${size} 文件）。`);
  }

  /**
   * 渲染批次列表：状态着色，失败批次带重试/拆半按钮
   */
  function renderBatches() {
    const box = document.getElementById('qbs-batches');
    if (!box) return;
    box.innerHTML = '';
    const mkBtn = (text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };
    S.batches.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'qbs-batch ' + b.status;
      const lbl = document.createElement('span');
      lbl.className = 'qbs-lbl';
      const st = { pending: '待转存', running: '转存中…', ok: '成功', failed: '失败' }[b.status] || b.status;
      lbl.textContent = `#${i + 1} [${b.relPath || '/'}] ${b.items.length}项/${b.leaves}文件 ${st}`;
      if (b.error) lbl.title = b.error;
      row.appendChild(lbl);
      if (b.status === 'failed' || b.status === 'pending') {
        row.appendChild(mkBtn('重试', () => rerunBatch(b)));
      }
      if (b.status === 'failed') {
        row.appendChild(mkBtn('拆半', () => { if (splitBatch(b)) renderBatches(); }));
      }
      box.appendChild(row);
    });
  }

  /**
   * 导出目录结构与批次结果为 JSON 文件（用户要求的"先保存目录结构"）
   */
  function exportJSON() {
    if (!S.tree) return setStatus('请先扫描再导出。');
    /**
     * 树节点精简（去掉接口 token 等敏感字段）
     */
    const slim = (n) => ({
      name: n.name || '/',
      isDir: n.isDir,
      leaves: n.isDir ? countLeaves(n) : 1,
      children: n.isDir ? n.children.map(slim) : undefined,
    });
    const data = {
      pwdId: S.pwdId,
      exportedAt: new Date().toISOString(),
      totals: S.stats,
      batchCount: S.batches.length,
      batches: S.batches.map((b, i) => ({
        index: i + 1, targetPath: b.relPath || '/', items: b.items.length,
        files: b.leaves, status: b.status, error: b.error || undefined,
      })),
      tree: slim(S.tree),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `quark-share-${S.pwdId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ==================== 网盘目录浏览器 ==================== */

  // 浏览器运行时状态：路径栈 [{name, fid}]，栈底固定为根目录
  const br = { path: [], list: [], loading: false };

  /**
   * 列出某目录下所有子目录（遍历全部分页，仅保留文件夹），按名称排序返回 [{fid, name}]
   */
  async function listDirs(pdirFid) {
    const out = [];
    for (let page = 1, seen = 0; page <= 100; page++) {
      await gap();
      const { list, total } = await listMyDir(pdirFid, page);
      if (!list.length) break;
      for (const it of list) if (isDirOf(it)) out.push({ fid: it.fid, name: it.file_name });
      seen += list.length;
      if (total > 0 ? seen >= total : list.length < PAGE_SIZE) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
  }

  /**
   * 懒创建浏览器弹窗 DOM，并绑定关闭/新建/选择按钮
   */
  function ensureBrowserDom() {
    if (document.getElementById('qbs-browser')) return;
    const m = document.createElement('div');
    m.id = 'qbs-browser';
    m.innerHTML = `
      <div class="qbs-br-box">
        <div class="qbs-br-head">选择目标目录<span class="qbs-br-close">✕</span></div>
        <div class="qbs-br-body">
          <div class="qbs-br-crumb" id="qbs-br-crumb"></div>
          <div id="qbs-br-list"></div>
        </div>
        <div class="qbs-br-actions">
          <button class="qbs-br-new" id="qbs-br-new">新建文件夹</button>
          <button class="qbs-br-select" id="qbs-br-select" style="margin-left:auto">选择此目录</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) closeBrowser(); });
    m.querySelector('.qbs-br-close').addEventListener('click', closeBrowser);
    m.querySelector('#qbs-br-new').addEventListener('click', newFolder);
    m.querySelector('#qbs-br-select').addEventListener('click', selectCurrentDir);
  }

  /**
   * 打开浏览器：重置到根目录并加载
   */
  async function openBrowser() {
    ensureBrowserDom();
    br.path = [{ name: '根目录', fid: '0' }];
    document.getElementById('qbs-browser').classList.add('show');
    await loadCurrentDir();
  }

  /**
   * 关闭浏览器弹窗
   */
  function closeBrowser() {
    document.getElementById('qbs-browser').classList.remove('show');
  }

  /**
   * 加载并渲染当前栈顶目录的子文件夹
   */
  async function loadCurrentDir() {
    if (br.loading) return;
    br.loading = true;
    const top = br.path[br.path.length - 1];
    renderBrowser([], '加载中…');
    try {
      br.list = await listDirs(top.fid);
      renderBrowser(br.list);
    } catch (e) {
      renderBrowser([], '加载失败：' + e.message);
    } finally {
      br.loading = false;
    }
  }

  /**
   * 渲染面包屑导航和文件夹列表
   */
  function renderBrowser(list, msg) {
    const crumb = document.getElementById('qbs-br-crumb');
    crumb.innerHTML = '';
    br.path.forEach((p, i) => {
      const s = document.createElement('span');
      s.textContent = p.name;
      if (i < br.path.length - 1) s.addEventListener('click', () => crumbTo(i));
      crumb.appendChild(s);
      if (i < br.path.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'qbs-sep';
        sep.textContent = '/';
        crumb.appendChild(sep);
      }
    });

    const box = document.getElementById('qbs-br-list');
    box.innerHTML = '';
    if (msg) {
      const e = document.createElement('div');
      e.className = 'qbs-br-empty';
      e.textContent = msg;
      box.appendChild(e);
      return;
    }
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'qbs-br-empty';
      e.textContent = '（此目录下没有文件夹）';
      box.appendChild(e);
      return;
    }
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'qbs-br-dir';
      row.innerHTML = `<span class="qbs-ic">📁</span><span>${d.name}</span>`;
      row.addEventListener('click', () => enterDir(d.name, d.fid));
      box.appendChild(row);
    }
  }

  /**
   * 进入指定子目录：压栈并刷新
   */
  async function enterDir(name, fid) {
    br.path.push({ name, fid });
    await loadCurrentDir();
  }

  /**
   * 面包屑跳转：截断路径栈到指定层级并刷新
   */
  async function crumbTo(idx) {
    if (idx >= br.path.length - 1) return;
    br.path = br.path.slice(0, idx + 1);
    await loadCurrentDir();
  }

  /**
   * 在当前目录下新建文件夹，成功后加入列表并刷新
   */
  async function newFolder() {
    const name = prompt('请输入新文件夹名称：');
    if (!name || !name.trim()) return;
    const top = br.path[br.path.length - 1];
    try {
      await gap();
      const fid = await mkdir(top.fid, name.trim());
      br.list.push({ fid, name: name.trim() });
      br.list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      renderBrowser(br.list);
    } catch (e) {
      alert('新建文件夹失败：' + e.message);
    }
  }

  /**
   * 选择当前目录为目标路径：路径栈中除根外的名称用 / 连接，填入输入框
   */
  function selectCurrentDir() {
    const parts = br.path.slice(1).map((p) => p.name);
    document.getElementById('qbs-dest').value = '/' + parts.join('/');
    closeBrowser();
  }

  /* ==================== 纯逻辑自检 ==================== */

  /**
   * 分批算法最小自检：叶子守恒 / 批次不超限 / 同批同源目录（不依赖网络）
   */
  function selfTest() {
    const mk = (name, isDir, children) => ({ name, isDir, children, fid: 'f_' + name, token: 't_' + name });
    const files = (n, p) => Array.from({ length: n }, (_, i) => mk(p + '_' + i, false, null));
    const tree = mk('', true, [
      mk('a', true, files(300, 'a')),
      mk('b', true, files(150, 'b')),
      mk('c', true, files(200, 'c')),
      mk('d', true, [mk('e', true, files(350, 'e')), ...files(100, 'd'), mk('f', true, files(350, 'f'))]),
      ...files(50, 'r'),
    ]);
    const total = countLeaves(tree);
    const bs = planBatches(tree, 300);
    const problems = [];
    const sum = bs.reduce((s, b) => s + b.leaves, 0);
    if (sum !== total) problems.push(`叶子不守恒: 批次和=${sum} 总数=${total}`);
    bs.forEach((b, i) => {
      // 批次大小按递归节点数限制（文件+文件夹，夸克对文件夹递归转存）
      if (b.nodes > 300) problems.push(`批次#${i + 1}节点超限: ${b.nodes}`);
      if (b.items.some((it) => b.srcPdirFid !== bs[i].srcPdirFid)) problems.push(`批次#${i + 1}混源`);
    });
    if (!bs.some((b) => b.relPath === 'd/e' && b.leaves === 300)) problems.push('超大目录 d/e 未正确下钻');
    if (problems.length) console.error('[夸克转存助手] 逻辑自检失败:', problems);
    else console.log('[夸克转存助手] 逻辑自检通过: 总数', total, '分', bs.length, '批');
    return problems;
  }

  /* ==================== 启动 ==================== */

  /**
   * 入口：自检 → 建面板 → 尝试免码授权
   */
  async function main() {
    selfTest();
    buildUI();
    if (!S.pwdId) return setStatus('未识别到分享 ID，请在标准分享页使用本脚本。');
    setStatus('正在自动获取访问权限…');
    const token = await autoAuth();
    if (token) {
      S.stoken = token;
      setStatus('已自动获取访问权限，可点击「① 扫描目录结构」。');
    } else {
      setStatus('自动授权失败 → 若分享需提取码，请填写后点「授权」。');
    }
  }

  main();
})();
