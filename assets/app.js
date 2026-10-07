/* ==========================================================================
   奶茶高考 · 前端核心
   纯静态，无框架。数据本地 JSON，一次 fetch 全量载入（620KB gzip 后约 150KB）。
   ========================================================================== */

const STATE = {
  schools: [],
  majors: [],
  score: null,
  facets: {},
  config: {},
  coverage: {},
};

/* ---------------- 数据载入 ---------------- */
async function boot() {
  const [s, m, sc, f, c] = await Promise.all([
    fetch('data/schools.json').then((r) => r.json()),
    fetch('data/majors.json').then((r) => r.json()),
    fetch('data/score2025.json').then((r) => r.json()),
    fetch('data/facets.json').then((r) => r.json()),
    fetch('data/config.json').then((r) => r.json()),
  ]);
  STATE.schools = s.schools;
  STATE.majors = m.majors;
  STATE.score = sc;
  STATE.facets = f.facets;
  STATE.config = c;
  STATE.coverage = s.meta.coverage;
  return STATE;
}

/* ---------------- 工具 ---------------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fmt = (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN'));

function qs(name, def) {
  const v = new URLSearchParams(location.search).get(name);
  return v == null ? def : v;
}
function setQs(patch) {
  const u = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) u.delete(k);
    else u.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  history.replaceState(null, '', u.toString() ? '?' + u.toString() : location.pathname);
}

function tierTags(s) {
  const out = [];
  if (s.is985) out.push('<span class="tg tg-985">985</span>');
  if (s.is211) out.push('<span class="tg tg-211">211</span>');
  if (s.isDoubleFirstClass) out.push('<span class="tg tg-dfc">双一流</span>');
  if (!out.length && s.isMilitary) out.push('<span class="tg tg-plain">军校</span>');
  return out.join('');
}

/* ---------------- 冲稳保 ----------------
   ratio = 我的位次 / 该校投档位次
   数字越小排名越靠前，故 ratio > 1.15 意味着我排得比它更靠前 = 够不着 → 冲
   与小程序 utils/filter.js tierJudgement 口径保持一致 */
function tierJudgement(school, subject, userRank) {
  const ar = school.admissionRank || {};
  const schoolRank = subject === 'hist' ? ar.histMinRank : ar.physMinRank;
  if (!userRank || !schoolRank) return null;
  const ratio = userRank / schoolRank;
  let label, cls, badge;
  if (ratio > 1.15) { label = '冲'; cls = 'rk-b1'; badge = '冲'; }
  else if (ratio >= 0.85) { label = '稳'; cls = 'rk-b2'; badge = '稳'; }
  else { label = '保'; cls = 'rk-b3'; badge = '保'; }
  return { label, cls, badge, ratio, schoolRank };
}

/* ---------------- 一分一段查询 ---------------- */
function scoreNearest(subject, score) {
  const rows = STATE.score && STATE.score[subject === 'hist' ? 'hist' : 'phys'];
  if (!rows || !rows.length || !score) return null;
  let best = null;
  for (const r of rows) {
    const sc = r.score != null ? r.score : r.scoreMin;
    if (sc == null) continue;
    if (sc <= score) { if (!best || sc > (best.score != null ? best.score : best.scoreMin)) best = r; }
  }
  if (!best) return null;
  const rank = best.rank != null ? best.rank : best.cumulative;
  return { score: best.score != null ? best.score : best.scoreMin, rank, raw: best };
}

/* ---------------- 院校卡片 ---------------- */
function schoolCard(s) {
  const ar = s.admissionRank || {};
  const rankBits = [];
  if (ar.physMinRank) rankBits.push(`<span class="r">物理类最低 <b>${fmt(ar.physMinRank)}</b> 位（${fmt(ar.physMinScore)} 分）</span>`);
  if (ar.histMinRank) rankBits.push(`<span class="r">历史类最低 <b>${fmt(ar.histMinRank)}</b> 位（${fmt(ar.histMinScore)} 分）</span>`);

  const bits = [];
  bits.push(`<span><i>类型</i> <b>${esc(s.category || '—')}</b></span>`);
  bits.push(`<span><i>办学者</i> ${esc(s.affiliation || '—')}</span>`);
  if (s.majorCount) bits.push(`<span><i>本科专业</i> <b>${s.majorCount}</b> 个${s.aceCount ? ` · 王牌 <b>${s.aceCount}</b>` : ''}</span>`);
  if (s.postgradRate != null) bits.push(`<span><i>保研率</i> <b>${s.postgradRate}%</b></span>`);
  if (s.doubleFirstClassDisciplines.length) bits.push(`<span><i>双一流学科</i> <b>${s.doubleFirstClassDisciplines.length}</b> 个</span>`);

  return `
  <article class="card" data-id="${esc(s.id)}">
    <div class="c-top">
      <div>
        <div class="c-name">${esc(s.name)}</div>
        <div class="c-loc">${esc([s.province, s.city].filter(Boolean).join(' · ')) || '—'}</div>
      </div>
      <div class="c-tags">${tierTags(s)}</div>
    </div>
    <div class="c-meta">${bits.join('')}</div>
    ${rankBits.length ? `<div class="c-rank">${rankBits.join('')}</div>` : ''}
  </article>`;
}

/* ================= 院校库页 ================= */
const filters = {
  q: '',
  provinces: new Set(),
  cities: new Set(),
  cats: new Set(),
  affils: new Set(),
  tiers: new Set(),
  subject: 'phys',
  userRank: null,
  sort: 'default',
  page: 1,
};
const PAGE = 20;

function readFiltersFromUrl() {
  const g = (k) => (qs(k) ? qs(k).split(',') : []);
  filters.q = qs('q', '');
  g('provinces').forEach((v) => filters.provinces.add(v));
  g('cities').forEach((v) => filters.cities.add(v));
  g('cats').forEach((v) => filters.cats.add(v));
  g('affils').forEach((v) => filters.affils.add(v));
  g('tiers').forEach((v) => filters.tiers.add(v));
  filters.subject = qs('subject', 'phys');
  filters.userRank = Number(qs('rank', '')) || null;
  filters.sort = qs('sort', 'default');
}

function matchQuery(s, q) {
  if (!q) return true;
  const t = q.toLowerCase();
  if (s.name.toLowerCase().includes(t)) return true;
  if ((s.city || '').toLowerCase().includes(t)) return true;
  if ((s.province || '').toLowerCase().includes(t)) return true;
  if ((s.affiliation || '').toLowerCase().includes(t)) return true;
  if (s.tags.some((x) => x.toLowerCase().includes(t))) return true;
  // 查专业 / 学科
  const ms = s.bachelorMajors.concat(s.aceMajors, s.doubleFirstClassDisciplines).join(' ');
  if (ms.toLowerCase().includes(t)) return true;
  return false;
}

function applyFilters() {
  let list = STATE.schools.filter((s) => {
    if (filters.provinces.size && !filters.provinces.has(s.province)) return false;
    if (filters.cities.size && !filters.cities.has(s.city)) return false;
    if (filters.cats.size && !filters.cats.has(s.category)) return false;
    if (filters.affils.size && !filters.affils.has(s.affiliation)) return false;
    if (filters.tiers.size) {
      const t = filters.tiers;
      const has =
        (t.has('985') && s.is985) ||
        (t.has('211') && s.is211) ||
        (t.has('双一流') && s.isDoubleFirstClass) ||
        (t.has('军校') && s.isMilitary);
      if (!has) return false;
    }
    return matchQuery(s, filters.q);
  });

  // 排序
  const subj = filters.subject;
  const rankOf = (s) => (subj === 'hist' ? s.admissionRank.histMinRank : s.admissionRank.physMinRank) || Infinity;
  const sw = {
    default: (a, b) => (b.tierScore - a.tierScore) || (b.cityScore - a.cityScore) || a.name.localeCompare(b.name, 'zh'),
    rank: (a, b) => rankOf(a) - rankOf(b),
    city: (a, b) => b.cityScore - a.cityScore,
    postgrad: (a, b) => (b.postgradRate || -1) - (a.postgradRate || -1),
    major: (a, b) => b.majorCount - a.majorCount,
    name: (a, b) => a.name.localeCompare(b.name, 'zh'),
  }[filters.sort] || null;
  if (sw) list.sort(sw);

  return list;
}

/* 侧边栏渲染 */
function renderSidebar() {
  const f = STATE.facets;
  const cnt = (o) => Object.keys(o).length;

  const tierBlock = [
    ['985', '985', 't-985'],
    ['211', '211', 't-211'],
    ['双一流', '双一流', 't-dfc'],
    ['军校', '军校', ''],
  ]
    .map(([k, label, cls]) => {
      const n = k === '985' ? STATE.coverage.tier985 : k === '211' ? STATE.coverage.tier211 : k === '双一流' ? STATE.coverage.tierDoubleFirstClass : STATE.schools.filter((s) => s.isMilitary).length;
      return `<button class="chip ${cls} ${filters.tiers.has(k) ? 'on' : ''}" data-tier="${k}">${label}<span class="chip-n">${n}</span></button>`;
    })
    .join('');

  const catBlock = Object.entries(f.category || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<button class="chip ${filters.cats.has(k) ? 'on' : ''}" data-cat="${esc(k)}">${esc(k)}<span class="chip-n">${v}</span></button>`)
    .join('');

  const provBlock = Object.entries(f.province || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<button class="chip ${filters.provinces.has(k) ? 'on' : ''}" data-prov="${esc(k)}">${esc(k)}<span class="chip-n">${v}</span></button>`)
    .join('');

  const cityBlock = Object.entries(f.city || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<button class="chip mini ${filters.cities.has(k) ? 'on' : ''}" data-city="${esc(k)}">${esc(k)}<span class="chip-n">${v}</span></button>`)
    .join('');

  const affilBlock = Object.entries(f.affiliation || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([k, v]) => `<button class="chip mini ${filters.affils.has(k) ? 'on' : ''}" data-affil="${esc(k)}">${esc(k)}<span class="chip-n">${v}</span></button>`)
    .join('');

  $('#side').innerHTML = `
    <div class="side-sec">
      <div class="side-h">院校层次</div>
      <div class="chips">${tierBlock}</div>
    </div>
    <div class="side-sec">
      <div class="side-h">学校类型</div>
      <div class="chips">${catBlock}</div>
    </div>
    <div class="side-sec">
      <div class="side-h">省份${filters.provinces.size ? '<button data-clear="provinces">清除</button>' : ''}</div>
      <div class="chips">${provBlock}</div>
    </div>
    <div class="side-sec">
      <div class="side-h">城市 ${filters.cities.size ? '<button data-clear="cities">清除</button>' : ''}<span style="font-weight:400;color:var(--ink-4)">${cnt(f.city || {})} 城</span></div>
      <div class="chips">${cityBlock}</div>
    </div>
    <div class="side-sec">
      <div class="side-h">办学者</div>
      <div class="chips">${affilBlock}</div>
    </div>`;
}

function activeFilterChips() {
  const out = [];
  filters.tiers.forEach((t) => out.push(['tiers', t, t]));
  filters.cats.forEach((c) => out.push(['cats', c, '类型：' + c]));
  filters.provinces.forEach((p) => out.push(['provinces', p, p]));
  filters.cities.forEach((c) => out.push(['cities', c, '城市：' + c]));
  filters.affils.forEach((a) => out.push(['affils', a, a]));
  if (filters.q) out.push(['q', filters.q, '搜索：' + filters.q]);
  if (!out.length) return '';
  return out
    .map(([kind, val, label]) => `<span class="af"><b>${esc(label)}</b><button data-rm-kind="${kind}" data-rm-val="${esc(val)}">×</button></span>`)
    .join('') + `<button class="chip mini" data-clear-all="1" style="border-style:dashed">全部清除</button>`;
}

function renderResults() {
  const list = applyFilters();
  const total = list.length;
  const shown = Math.min(total, filters.page * PAGE);

  const per = PAGE;
  const pageList = filters.page === 1 ? list.slice(0, per) : list.slice((filters.page - 1) * per, shown);

  $('#results').innerHTML = `
    <div class="res-h">
      <span class="res-n"><b>${fmt(total)}</b> 所院校</span>
      <label class="sel">排序
        <select id="sortSel">
          <option value="default"${filters.sort === 'default' ? ' selected' : ''}>综合推荐</option>
          <option value="rank"${filters.sort === 'rank' ? ' selected' : ''}>录取位次（低→高）</option>
          <option value="city"${filters.sort === 'city' ? ' selected' : ''}>城市能级</option>
          <option value="major"${filters.sort === 'major' ? ' selected' : ''}>本科专业数</option>
          <option value="postgrad"${filters.sort === 'postgrad' ? ' selected' : ''}>保研率</option>
          <option value="name"${filters.sort === 'name' ? ' selected' : ''}>名称</option>
        </select>
      </label>
    </div>
    <div class="active-f">${activeFilterChips()}</div>
    ${pageList.length ? `<div class="cards">${pageList.map(schoolCard).join('')}</div>` : `<div class="empty"><b>没有匹配的院校</b>试试减少筛选条件，或换个关键词</div>`}
    ${shown < total ? `<div class="more"><button id="loadMore">加载更多（还有 ${fmt(total - shown)} 所）</button></div>` : ''}`;

  $('#loadMore') && $('#loadMore').addEventListener('click', () => { filters.page++; renderResults(); syncUrl(); });
  $('#sortSel') && $('#sortSel').addEventListener('change', (e) => { filters.sort = e.target.value; filters.page = 1; renderResults(); syncUrl(); });
}

function syncUrl() {
  setQs({
    q: filters.q,
    provinces: [...filters.provinces],
    cities: [...filters.cities],
    cats: [...filters.cats],
    affils: [...filters.affils],
    tiers: [...filters.tiers],
    subject: filters.subject === 'phys' ? '' : filters.subject,
    rank: filters.userRank || '',
    sort: filters.sort === 'default' ? '' : filters.sort,
  });
}

/* ---------------- 详情页 ---------------- */
function renderSchoolDetail(id) {
  const s = STATE.schools.find((x) => x.id === id);
  if (!s) { document.body.innerHTML = '<div class="wrap" style="padding:80px 20px;text-align:center">未找到该院校 <a href="index.html" style="color:var(--brand)">返回院校库</a></div>'; return; }

  const ar = s.admissionRank || {};
  const cov = STATE.coverage;

  document.title = `${s.name} · 奶茶高考`;
  $('#content').innerHTML = `
  <div class="sub-hero">
    <div class="wrap">
      <div class="bcrumb"><a href="index.html">院校库</a> › ${esc(s.province || '')} › ${esc(s.name)}</div>
      <div class="d-title">
        <h1>${esc(s.name)}</h1>
        <div class="c-tags" style="margin-left:4px">${tierTags(s)}</div>
      </div>
      <div class="d-sub">
        ${s.city ? `<span><i>所在地</i> ${esc(s.province)} · ${esc(s.city)}</span>` : ''}
        ${s.category ? `<span><i>类型</i> ${esc(s.category)}</span>` : ''}
        ${s.affiliation ? `<span><i>办学者</i> ${esc(s.affiliation)}</span>` : ''}
        <span><i>性质</i> ${esc(s.ownership || '公办')}</span>
      </div>
    </div>
  </div>

  <div class="wrap d-grid">
    <div>
      ${s.intro ? `<div class="panel"><div class="panel-h">院校简介</div><div class="panel-b" style="font-size:14px;line-height:1.8;color:var(--ink-2)">${esc(s.intro)}</div></div>` : ''}

      ${s.doubleFirstClassDisciplines.length ? `<div class="panel"><div class="panel-h">双一流建设学科 <span class="hint">${s.doubleFirstClassDisciplines.length} 个</span></div>
        <div class="panel-b"><div class="taglist">${s.doubleFirstClassDisciplines.map((d) => `<span class="dfc">${esc(d)}</span>`).join('')}</div></div></div>` : ''}

      ${s.aceMajors.length ? `<div class="panel"><div class="panel-h">王牌专业 <span class="hint">${s.aceMajors.length} 个</span></div>
        <div class="panel-b"><div class="taglist">${s.aceMajors.map((m) => `<span class="ace">${esc(m)}</span>`).join('')}</div></div></div>` : ''}

      ${s.bachelorMajors.length ? `<div class="panel"><div class="panel-h">本科专业设置 <span class="hint">${s.majorCount} 个 · 数据来自教育部名单</span></div>
        <div class="panel-b"><div class="taglist">${s.bachelorMajors.map((m) => {
          const maj = STATE.majors.find((x) => x.name === m);
          return maj ? `<a href="major.html?id=${esc(maj.id)}">${esc(m)}</a>` : `<span>${esc(m)}</span>`;
        }).join('')}</div></div></div>` : ''}

      ${s.address ? `<div class="panel"><div class="panel-h">基本信息</div><div class="panel-b">
        <dl class="kv">
          <dt>详细地址</dt><dd>${esc(s.address)}</dd>
          ${s.moeCode ? `<dt>教育部代码</dt><dd>${esc(s.moeCode)}</dd>` : ''}
          ${s.postgradRate != null ? `<dt>保研率</dt><dd><b style="color:var(--brand)">${s.postgradRate}%</b></dd>` : ''}
        </dl></div></div>` : ''}

      ${ar.physMinRank || ar.histMinRank ? `<div class="panel"><div class="panel-h">河南录取参考 <span class="hint">2025 年普通类</span></div>
        <div class="rk-card">
          <div class="note" style="margin-bottom:12px"><b>口径说明：</b>以下为<b>录取最低分</b>口径，非投档线。填报志愿时应以河南省教育考试院公布的投档线二次校准。</div>
          ${ar.physMinRank ? rkRow('物理类', ar.physMinScore, ar.physMinRank) : ''}
          ${ar.histMinRank ? rkRow('历史类', ar.histMinScore, ar.histMinRank) : ''}
        </div></div>` : `<div class="panel"><div class="panel-h">河南录取参考</div>
        <div class="panel-b"><div class="empty-inline">该校录取位次数据暂无收录</div></div></div>`}

      ${s.admissionNote ? `<div class="panel"><div class="panel-h">数据来源与口径</div><div class="panel-b" style="font-size:12.5px;color:var(--ink-3);line-height:1.75">${esc(s.admissionNote)}</div></div>` : ''}
    </div>

    <div class="side">
      <div class="side-sec">
        <div class="side-h">冲稳保定位</div>
        <div class="seg" id="subjSeg" style="margin-bottom:10px">
          <button class="${filters.subject === 'phys' ? 'on' : ''}" data-s="phys">物理类</button>
          <button class="${filters.subject === 'hist' ? 'on' : ''}" data-s="hist">历史类</button>
        </div>
        <div class="inp" style="margin-bottom:10px" id="rankInput" contenteditable="true" spellcheck="false" role="textbox" aria-label="我的位次">${filters.userRank || '输入我的位次'}</div>
        <div id="judgeBox"></div>
      </div>

      <div class="side-sec">
        <div class="side-h">同类院校</div>
        <div id="similar"></div>
      </div>

      <div class="side-sec">
        <div class="side-h">本站数据完整度</div>
        <div style="font-size:11.5px;color:var(--ink-4);line-height:1.6;margin-bottom:8px">全站 ${fmt(cov.total)} 所公办本科院校</div>
        ${covRows(cov)}
      </div>
    </div>
  </div>`;

  renderJudge(s);
  renderSimilar(s);

  $('#rankInput').addEventListener('blur', () => {
    const v = parseInt($('#rankInput').innerText.replace(/[^\d]/g, ''), 10);
    filters.userRank = v || null;
    if (!v) $('#rankInput').innerText = '输入我的位次';
    renderJudge(s);
    syncUrl();
  });
  $('#rankInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#rankInput').blur(); });
  $$('#subjSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#subjSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    filters.subject = b.dataset.s;
    renderJudge(s);
    syncUrl();
  }));
}

function rkRow(label, score, rank) {
  return `<div class="rk-row">
    <div class="rk-info"><b>${label}· ${fmt(score)} 分</b><span>最低录取位次 ${fmt(rank)}</span></div>
  </div>`;
}

function renderJudge(s) {
  const box = $('#judgeBox');
  if (!box) return;
  const ar = s.admissionRank || {};
  const schoolRank = filters.subject === 'hist' ? ar.histMinRank : ar.physMinRank;
  const score = filters.subject === 'hist' ? ar.histMinScore : ar.physMinScore;

  if (!filters.userRank) {
    box.innerHTML = `<div class="empty-inline" style="text-align:left">输入你的位次，自动判断这所学校是「冲 /稳 / 保」</div>`;
    return;
  }
  if (!schoolRank) {
    box.innerHTML = `<div class="empty-inline" style="text-align:left">该校暂无${filters.subject === 'hist' ? '历史类' : '物理类'}录取位次数据，无法判断</div>`;
    return;
  }
  const j = tierJudgement(s, filters.subject, filters.userRank);
  const near = scoreNearest(filters.subject, score);
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0 12px">
      <div class="rk-badge ${j.cls}">${j.badge}</div>
      <div style="font-size:12.5px;color:var(--ink-2);line-height:1.5">
        你的位次 <b>${fmt(filters.userRank)}</b> vs 校内参考位次 <b>${fmt(j.schoolRank)}</b><br>
        <span style="color:var(--ink-4)">比值 ${j.ratio.toFixed(2)}（越接近 1 越匹配）</span>
      </div>
    </div>
    ${near ? `<div style="font-size:11.5px;color:var(--ink-4);border-top:1px dashed var(--line);padding-top:9px">参考：${fmt(score)} 分在 2025 河南${filters.subject === 'hist' ? '历史类' : '物理类'}一分一段中约排 ${fmt(near.rank)} 位</div>` : ''}`;
}

function renderSimilar(s) {
  const box = $('#similar');
  if (!box) return;
  const list = STATE.schools
    .filter((x) => x.id !== s.id && (x.province === s.province || x.category === s.category) && x.is985 === s.is985 && x.is211 === s.is211)
    .sort((a, b) => b.tierScore - a.tierScore || b.cityScore - a.cityScore)
    .slice(0, 12);
  box.innerHTML = list
    .map((x) => `<a href="school.html?id=${encodeURIComponent(x.id)}" style="display:block;padding:6px 0;font-size:13px;border-bottom:1px solid var(--line-2)">
      <span style="color:var(--ink)">${esc(x.name)}</span>
      <span style="color:var(--ink-4);font-size:11.5px;float:right">${esc(x.city || '')}</span></a>`)
    .join('') || '<div class="empty-inline">暂无</div>';
}

function covRows(cov) {
  const t = cov.total;
  const rows = [
    ['院校层次', cov.total],
    ['双一流学科', cov.doubleFirstClassDisciplines],
    ['录取位次', cov.admissionRank],
    ['保研率', cov.postgradRate],
    ['专业设置', cov.bachelorMajors],
    ['院校简介', cov.intro],
  ];
  return rows.map(([k, v]) => `<div class="cov-row">
    <span class="cov-n">${k}</span>
    <span class="cov-bar"><i style="width:${((v / t) * 100).toFixed(1)}%"></i></span>
    <span class="cov-v">${v}/${t}</span>
  </div>`).join('');
}

/* ---------------- 专业库页 ---------------- */
function renderMajors() {
  document.title = '专业库 · 奶茶高考';
  const groups = STATE.config.majorGroups || [];
  const q = qs('q', '').toLowerCase();
  let list = STATE.majors;
  if (q) list = list.filter((m) => m.name.toLowerCase().includes(q) || (m.category || '').toLowerCase().includes(q) || (m.prospects || '').toLowerCase().includes(q));
  const actCat = qs('cat', '');

  $('#content').innerHTML = `
  <div class="sub-hero">
    <div class="wrap">
      <div class="bcrumb"><a href="index.html">首页</a> › 专业库</div>
      <div class="d-title"><h1>专业库</h1></div>
      <div class="d-sub"><span>${STATE.majors.length} 个本科专业方向 · 每个专业附开设院校与就业分析</span></div>
    </div>
  </div>
  <div class="wrap" style="padding:22px 0 60px">
    <div class="searchbar" style="margin-bottom:18px">
      <input id="mq" placeholder="搜专业名称，如 计算机 / 临床医学 / 法学" value="${esc(qs('q', ''))}">
    </div>
    <div class="chips" style="margin-bottom:18px">
      <button class="chip ${!actCat ? 'on' : ''}" data-mcat="">全部<span class="chip-n">${STATE.majors.length}</span></button>
      ${groups.map((g) => `<button class="chip ${actCat === g.key ? 'on' : ''}" data-mcat="${esc(g.key)}">${g.icon} ${esc(g.label)}<span class="chip-n">${STATE.majors.filter((m) => m.category === g.key).length}</span></button>`).join('')}
    </div>
    <div class="mgrid">
      ${list.map((m) => `<article class="mcard" data-id="${esc(m.id)}">
        <h3>${esc(m.name)}</h3>
        <div class="mcat">${esc(m.category || '')}${m.duration ? ' · ' + esc(m.duration) : ''}</div>
        <div class="mdeg">${esc(m.degree || '')}</div>
        <div class="mn">${m.schoolsCount ? `已知 <b>${m.schoolsCount}</b> 所开设院校` : '<span style="color:var(--ink-4)">开设院校暂无数据</span>'}</div>
      </article>`).join('')}
    </div>
    ${list.length ? '' : '<div class="empty" style="margin-top:20px"><b>没有匹配的专业</b>换个关键词试试</div>'}
  </div>`;

  $('#mq').addEventListener('input', (e) => {
    const v = e.target.value;
    setQs({ q: v });
    clearTimeout(window.__mt);
    window.__mt = setTimeout(() => { const pos = e.target.selectionStart; renderMajors(); const el = $('#mq'); el.focus(); el.setSelectionRange(pos, pos); }, 260);
  });
  $$('[data-mcat]').forEach((b) => b.addEventListener('click', () => { setQs({ cat: b.dataset.mcat }); renderMajors(); }));
  $$('.mcard').forEach((c) => c.addEventListener('click', () => (location.href = 'major.html?id=' + encodeURIComponent(c.dataset.id))));
}

function renderMajorDetail(id) {
  const m = STATE.majors.find((x) => x.id === id);
  if (!m) { document.body.innerHTML = '<div class="wrap" style="padding:80px 20px;text-align:center">未找到该专业</div>'; return; }
  document.title = `${m.name} · 奶茶高考`;
  const ca = m.careerAnalysis || {};
  const row = (k, v) => (v ? `<div class="rk-row"><div class="rk-info"><b>${k}</b><span>${esc(v.note || '')}</span></div><div class="rk-badge ${k === '本科' ? 'rk-b2' : k === '硕士' ? 'rk-b1' : 'rk-b3'}">${esc(v.competitiveness || '')}</div></div>` : '');

  $('#content').innerHTML = `
  <div class="sub-hero">
    <div class="wrap">
      <div class="bcrumb"><a href="majors.html">专业库</a> › ${esc(m.name)}</div>
      <div class="d-title"><h1>${esc(m.name)}</h1></div>
      <div class="d-sub">
        <span><i>学科门类</i> ${esc(m.category || '—')}</span>
        ${m.degree ? `<span><i>授予学位</i> ${esc(m.degree)}</span>` : ''}
        ${m.duration ? `<span><i>学制</i> ${esc(m.duration)}</span>` : ''}
      </div>
    </div>
  </div>
  <div class="wrap d-grid">
    <div>
      ${m.prospects ? `<div class="panel"><div class="panel-h">前景概览</div><div class="panel-b" style="font-size:14px;line-height:1.85;color:var(--ink-2)">${esc(m.prospects)}</div></div>` : ''}
      ${m.coreCourses && m.coreCourses.length ? `<div class="panel"><div class="panel-h">核心课程</div><div class="panel-b"><div class="taglist">${m.coreCourses.map((c) => `<span>${esc(c)}</span>`).join('')}</div></div></div>` : ''}
      ${m.employmentDirections && m.employmentDirections.length ? `<div class="panel"><div class="panel-h">就业方向</div><div class="panel-b"><div class="taglist">${m.employmentDirections.map((c) => `<span>${esc(c)}</span>`).join('')}</div></div></div>` : ''}
      ${m.industryFit && m.industryFit.length ? `<div class="panel"><div class="panel-h">对口行业</div><div class="panel-b"><div class="taglist">${m.industryFit.map((c) => `<span>${esc(c)}</span>`).join('')}</div></div></div>` : ''}
      ${m.relatedMajors && m.relatedMajors.length ? `<div class="panel"><div class="panel-h">相关专业</div><div class="panel-b"><div class="taglist">${m.relatedMajors.map((r) => {
        const t = STATE.majors.find((x) => x.name === r);
        return t ? `<a href="major.html?id=${esc(t.id)}">${esc(r)}</a>` : `<span>${esc(r)}</span>`;
      }).join('')}</div></div></div>` : ''}
      ${m.schoolsOffering && m.schoolsOffering.length ? `<div class="panel"><div class="panel-h">已知开设院校 <span class="hint">${m.schoolsCount} 所 · 来自教育部名单交叉匹配</span></div>
        <div class="panel-b" style="padding:0">
          <table class="tbl"><thead><tr><th>院校</th><th>城市</th><th>层次</th></tr></thead><tbody>
          ${m.schoolsOffering.map((s) => `<tr style="cursor:pointer" onclick="location.href='school.html?id=${encodeURIComponent(s.id)}'">
            <td><b>${esc(s.name)}</b></td><td>${esc([s.province, s.city].filter(Boolean).join(' · '))}</td>
            <td>${tierTags(s)}</td></tr>`).join('')}
          </tbody></table>
        </div></div>` : `<div class="panel"><div class="panel-h">开设院校</div><div class="panel-b"><div class="empty-inline">该专业开设院校数据暂无收录</div></div></div>`}
    </div>
    <div class="side">
      <div class="side-sec"><div class="side-h">深造与竞争力</div><div style="font-size:13px">
        ${row('本科', ca.bachelor)}${row('硕士', ca.master)}${row('博士', ca.phd) || '<div class="empty-inline">暂无数据</div>'}
      </div></div>
      ${m.salaryNote ? `<div class="side-sec"><div class="side-h">薪酬参考</div><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7">${esc(m.salaryNote)}</div></div>` : ''}
      <div class="side-sec"><div class="side-h">说明</div><div style="font-size:11.5px;color:var(--ink-4);line-height:1.7">专业竞争度为定性判断，非量化就业统计。薪酬信息因城市、行业、个人差异较大，仅供参考。</div></div>
    </div>
  </div>`;
}

/* ---------------- 一分一段页 ---------------- */
function renderScore() {
  document.title = '一分一段 · 奶茶高考';
  const subj = qs('subject', 'phys') === 'hist' ? 'hist' : 'phys';
  const input = qs('score', '');

  $('#content').innerHTML = `
  <div class="sub-hero">
    <div class="wrap">
      <div class="bcrumb"><a href="index.html">首页</a> › 一分一段</div>
      <div class="d-title"><h1>河南一分一段表</h1></div>
      <div class="d-sub"><span>2025 年 · 河南省教育考试院公布分数段统计表</span></div>
    </div>
  </div>
  <div class="wrap tool-grid">
    <div>
      <div class="panel">
        <div class="panel-h">分数查位次</div>
        <div class="panel-b">
          <div class="seg" id="sSeg" style="margin-bottom:12px">
            <button class="${subj === 'phys' ? 'on' : ''}" data-s="phys">物理类</button>
            <button class="${subj === 'hist' ? 'on' : ''}" data-s="hist">历史类</button>
          </div>
          <input class="inp" id="scoreIn" type="number" min="0" max="750" placeholder="输入高考分数" value="${esc(input)}">
          <div id="scoreRes" style="margin-top:14px"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-h">数据说明</div>
        <div class="panel-b"><div class="note">${esc((STATE.score.meta && STATE.score.meta.note) || '数据来源于河南省教育考试院公布的分数段统计表。')}
        <br><br>${esc((STATE.score.meta && STATE.score.meta.caliberWarning) || '')}</div></div>
      </div>
    </div>
    <div>
      <div class="tbl-wrap"><table class="tbl" id="scoreTbl"></table></div>
    </div>
  </div>`;

  const draw = () => {
    const rows = (STATE.score[subj] || []).slice().sort((a, b) => {
      const av = a.score != null ? a.score : a.scoreMin;
      const bv = b.score != null ? b.score : b.scoreMin;
      return (bv || 0) - (av || 0);
    });
    const rowHtml = (r) => {
      const sc = r.score != null ? r.score : r.scoreMin;
      const rk = r.rank != null ? r.rank : r.cum != null ? r.cum : r.cumulative;
      const cnt = r.count != null ? r.count : '';
      return `<tr><td><b>${sc}</b></td><td>${fmt(cnt)}</td><td><b>${fmt(rk)}</b></td>${r.note ? `<td class="note">${esc(r.note)}</td>` : ''}</tr>`;
    };

    const hasNote = rows.some((r) => r.note);
    $('#scoreTbl').innerHTML =
      `<thead><tr><th>分数</th><th>本分人数</th><th>累计位次</th>${hasNote ? '<th>备注</th>' : ''}</tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody>`;

    const v = parseFloat($('#scoreIn').value);
    const box = $('#scoreRes');
    if (!v) { box.innerHTML = '<div class="empty-inline">输入分数查看对应位次</div>'; return; }
    const n = scoreNearest(subj, v);
    box.innerHTML = n
      ? `<div class="res-box"><div class="big">${fmt(n.rank)}</div><div class="lbl">${subj === 'hist' ? '历史类' : '物理类'}位次（按 ${n.score} 分计，该分 ${fmt(n.raw.count != null ? n.raw.count : 0)} 人）</div></div>`
      : '<div class="empty-inline">分数超出表格范围</div>';
  };

  draw();
  $('#scoreIn').addEventListener('input', draw);
  $$('#sSeg button').forEach((b) => b.addEventListener('click', () => {
    setQs({ subject: b.dataset.s });
    renderScore();
  }));
}

/* ---------------- 数据说明页 ---------------- */
function renderAbout() {
  document.title = '数据说明 · 奶茶高考';
  const c = STATE.coverage;
  const t = c.total;
  $('#content').innerHTML = `
  <div class="sub-hero"><div class="wrap">
    <div class="bcrumb"><a href="index.html">首页</a> › 数据说明</div>
    <div class="d-title"><h1>数据来源与完整度</h1></div>
    <div class="d-sub"><span>本站所有数据均标注来源，未覆盖的部分明确留空，不做估算</span></div>
  </div></div>
  <div class="wrap" style="padding:22px 0 60px;max-width:820px">
    <div class="panel"><div class="panel-h">各字段覆盖率</div><div class="panel-b">
      ${[['院校基础信息（层次/城市/办学者/类型）', c.total],
         ['双一流建设学科（官方名单）', c.doubleFirstClassDisciplines],
         ['河南录取位次（2025）', c.admissionRank],
         ['保研率', c.postgradRate],
         ['本科专业设置', c.bachelorMajors],
         ['王牌专业', c.aceMajors],
         ['院校简介', c.intro],
         ['详细地址', c.address]].map(([k, v]) => `<div class="cov-row">
        <span class="cov-n" style="width:250px">${k}</span>
        <span class="cov-bar"><i style="width:${((v / t) * 100).toFixed(1)}%"></i></span>
        <span class="cov-v">${v} / ${t}</span></div>`).join('')}
      <div class="note" style="margin-top:14px"><b>诚实披露：</b>录取位次、保研率、专业设置这三项覆盖率偏低。缺失的院校对应字段留空并标注「暂无数据」，<b>不做任何估算、推测或用同类院校均值填充</b>。站内所有筛选与排序在数据缺失时按可用字段计算。</div>
    </div></div>

    <div class="panel"><div class="panel-h">数据来源</div><div class="panel-b" style="font-size:13.5px;line-height:1.85;color:var(--ink-2)">
      <p style="margin-bottom:10px"><b style="color:var(--ink)">院校基础名单</b><br>教育部《全国高等学校名单》（2025 年 6 月公布），共 ${t} 所公办本科院校，另补充教育部名单未收录但真实存在的军校院校。</p>
      <p style="margin-bottom:10px"><b style="color:var(--ink)">985 / 211 / 双一流</b><br>教育部公布的「双一流建设高校及建设学科名单」与 985/211 工程名单，按校名匹配。</p>
      <p style="margin-bottom:10px"><b style="color:var(--ink)">本科专业设置</b><br>教育部名单中各校的本科专业设置字段。</p>
      <p style="margin-bottom:10px"><b style="color:var(--ink)">河南一分一段</b><br>${esc((STATE.score.meta && STATE.score.meta.rankSource) || '河南省教育考试院公布数据')}</p>
      <p><b style="color:var(--ink)">河南录取位次</b><br>公开渠道整理的各校 2025 年普通类录取最低分，再由一分一段表换算为累计位次。</p>
    </div></div>

    <div class="panel"><div class="panel-h">重要口径提醒</div><div class="panel-b"><div class="note">
      <b>1. 录取最低分 ≠ 投档线。</b>本站位次为「录取最低分」口径，而志愿填报应参考省考试院公布的<b>投档线</b>。两者可能相差数十甚至上百分。例如郑州大学物理类录取最低 593 分（位次 54059），而其物理+不限专业组投档线为 601 分（位次 44843）。<br><br>
      <b>2. 冲稳保仅供定位参考。</b>位次比对无法反映专业组差异、招生计划变化、征集志愿等因素。<br><br>
      <b>3. 保研率口径不统一。</b>各校统计标准存在差异，跨校比较需谨慎。
    </div></div></div>
  </div>`;
}