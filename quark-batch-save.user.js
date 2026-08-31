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
  const DEFAULT_BATCH = 300;  // 每批最大文件数（含文件夹内文件，官方上限500，留余量）
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

  /* ==================== 分批算法（纯逻辑，无 IO） ==================== */

  /**
   * 统计目录树下文件总数（叶子数）
   */
  function countLeaves(node) {
    if (!node.isDir) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  /**
   * 生成分批计划：同目录子项贪心装箱，装满即出一批；
   * 单个文件夹叶子数超限时下钻进其内部继续拆，转存后在目标侧重建该层目录。
   * ponytail: 朴素贪心而非最优装箱，批次数可能略多，但实现简单且能处理任意超大树
   */
  function planBatches(root, batchSize) {
    const out = [];
    /**
     * 遍历某目录的子项装箱；batch 装满则 flush
     */
    function walk(children, relPath, srcPdirFid) {
      let cur = null;
      const newBatch = () => ({ relPath, srcPdirFid, items: [], leaves: 0, status: 'pending', error: '' });
      const flush = () => { if (cur && cur.items.length) out.push(cur); cur = null; };
      for (const child of children) {
        const w = child.isDir ? countLeaves(child) : 1;
        if (child.isDir && w > batchSize) {
          // 超大文件夹：整体转存必超限 → 下钻到子级，目标路径加上该层
          flush();
          const rp = relPath ? `${relPath}/${child.name}` : child.name;
          walk(child.children, rp, child.fid);
          continue;
        }
        if (!cur) cur = newBatch();
        if (cur.leaves + w > batchSize) { flush(); cur = newBatch(); }
        cur.items.push(child);
        cur.leaves += w;
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
   * 转存一批：定位/创建目标目录（用户目标路径 + 分享内相对路径）→ 发起转存 → 轮询任务直到完成
   */
  async function runBatch(b) {
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
    setStatus(fail
      ? `完成：成功 ${ok} 批，失败 ${fail} 批。可对失败批次重试或拆半重试。`
      : `全部完成：${ok} 批转存成功，共 ${S.stats.files} 个文件已保存到目标路径。`);
  }

  /**
   * 重试单个失败批次（原样重跑）
   */
  async function rerunBatch(b) {
    if (S.running || b.status === 'ok') return;
    b.status = 'running'; b.error = '';
    renderBatches();
    try { await runBatch(b); b.status = 'ok'; }
    catch (e) { b.status = 'failed'; b.error = e.message; }
    renderBatches();
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
        <div class="qbs-row">目标路径 <input id="qbs-dest" value="/" title="保存到我的网盘的路径，如 /转存合集"></div>
        <div class="qbs-row">每批数量 <input id="qbs-size" type="number" min="1" max="500" value="${DEFAULT_BATCH}"></div>
        <div class="qbs-row"><button id="qbs-run" style="flex:1">② 开始转存</button></div>
        <div class="qbs-row"><button id="qbs-retry">重试全部失败</button>
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
      replan(size);
      S.running = true;
      setBusy(true);
      try { await runAll(); }
      finally { S.running = false; setBusy(false); }
    });

    document.getElementById('qbs-retry').addEventListener('click', async () => {
      if (S.running) return;
      const failed = S.batches.filter((b) => b.status === 'failed');
      if (!failed.length) return setStatus('没有失败批次。');
      S.running = true;
      setBusy(true);
      try { await runAll(); }
      finally { S.running = false; setBusy(false); }
    });

    document.getElementById('qbs-export').addEventListener('click', exportJSON);
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
   * （重新）生成分批计划并刷新列表；仅在无进度或用户确认后调用
   */
  function replan(size) {
    size = size || Math.max(1, Math.min(500, Number(document.getElementById('qbs-size').value) || DEFAULT_BATCH));
    S.batches = planBatches(S.tree, size);
    S.plannedKey = planKey(size);
    renderBatches();
    setStatus(`共 ${S.stats.files} 个文件 / ${S.stats.dirs} 个文件夹，将分 ${S.batches.length} 批转存（每批 ≤${size} 文件）。`);
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
      if (b.status === 'failed') {
        row.appendChild(mkBtn('重试', () => rerunBatch(b)));
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
      if (b.leaves > 300) problems.push(`批次#${i + 1}超限: ${b.leaves}`);
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
    try {
      S.stoken = await fetchToken('');
      setStatus('已自动授权（无需提取码），可点击「① 扫描目录结构」。');
    } catch (e) {
      setStatus('自动授权失败：' + e.message + ' → 若分享需提取码请填写后点「授权」。');
    }
  }

  main();
})();
