/**
 * 构建网站数据产物
 *
 * 输入：GaokaoApp 小程序内的数据包（module.exports 格式的 JS）
 * 输出：gaokao-web/site/data/*.json（静态站直接 fetch）
 *
 * 设计要点：
 * 1. 合并 schools（索引）与 schools-detail（详情）为单份完整数据，避免前端两次请求再合并。
 * 2.缺失字段一律写 null，绝不填占位假值；覆盖率写入 meta，前端据此显式提示"暂无数据"。
 * 3. 预先算好分面统计（facets），前端筛选器直接消费，避免每次遍历 951 条。
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'GaokaoApp');
const OUT = path.join(__dirname, '..', 'site', 'data');

const read = (p) => require(p);
const unwrap = (mod) => (Array.isArray(mod) ? mod : (mod.schools || mod.majors || mod.data || mod));

// ---------- 载入 ----------
const schoolIdx = unwrap(read(path.join(APP, 'miniprogram/data/schools.js')));
const detailMod = read(path.join(APP, 'miniprogram/pkg-detail/data/schools-detail.js'));
const majorMod = unwrap(read(path.join(APP, 'miniprogram/data/majors.js')));
const scoreMod = read(path.join(APP, 'miniprogram/data/score2025.js'));
const filter = read(path.join(APP, 'miniprogram/utils/filter.js'));

const details = detailMod.details || {};
console.log(`载入：索引 ${schoolIdx.length} 所 / 详情 ${Object.keys(details).length} 条 / 专业 ${majorMod.length} 个`);

// ---------- 合并 ----------
const schools = schoolIdx.map((s) => {
  const d = details[s.id] || {};
  return {
    id: s.id,
    name: s.name,
    city: s.city || null,
    province: s.province || null,
    category: s.category || null,
    ownership: s.ownership || '公办',
    affiliation: s.affiliation || null,

    // 层次
    tags: Array.isArray(s.tags) ? s.tags : [],
    is985: !!s.is985,
    is211: !!s.is211,
    isDoubleFirstClass: !!s.isDoubleFirstClass,
    isMilitary: !!s.isMilitary,
    isVocationalBachelor: !!s.isVocationalBachelor,

    // 学术
    postgradRate: typeof s.postgradRate === 'number' ? s.postgradRate : null,
    doubleFirstClassDisciplines: Array.isArray(d.doubleFirstClassDisciplines) ? d.doubleFirstClassDisciplines : [],

    // 专业
    bachelorMajors: Array.isArray(d.bachelorMajors) ? d.bachelorMajors : [],
    aceMajors: Array.isArray(d.aceMajors) ? d.aceMajors : [],
    majorCount: Array.isArray(d.bachelorMajors) ? d.bachelorMajors.length : 0,
    aceCount: Array.isArray(d.aceMajors) ? d.aceMajors.length : 0,

    // 分数 / 位次
    admissionRank: s.admissionRank || { physMinScore: null, physMinRank: null, histMinScore: null, histMinRank: null },
    admissionNote: s.admissionNote || null,

    // 其他
    address: d.address || null,
    intro: d.intro || null,
    moeCode: d.moeCode || null,
    source: d.source || null,

    // 预计算分值（供排序与权重评分用，避免前端重复计算）
    cityScore: filter.cityScore(s.city) || 0,
    tierScore: filter.tierScore(s) || 0,
  };
});

// ---------- 覆盖率统计 ----------
const cov = {
  total: schools.length,
  tier985: schools.filter((s) => s.is985).length,
  tier211: schools.filter((s) => s.is211).length,
  tierDoubleFirstClass: schools.filter((s) => s.isDoubleFirstClass).length,
  postgradRate: schools.filter((s) => s.postgradRate != null).length,
  doubleFirstClassDisciplines: schools.filter((s) => s.doubleFirstClassDisciplines.length > 0).length,
  bachelorMajors: schools.filter((s) => s.majorCount > 0).length,
  aceMajors: schools.filter((s) => s.aceCount > 0).length,
  admissionRank: schools.filter((s) => s.admissionRank && (s.admissionRank.physMinRank || s.admissionRank.histMinRank)).length,
  intro: schools.filter((s) => s.intro).length,
  address: schools.filter((s) => s.address).length,
  henanSchools: schools.filter((s) => s.province === '河南').length,
  provinces: new Set(schools.map((s) => s.province)).size,
  cities: new Set(schools.map((s) => s.city)).size,
};

// 前置校验：合并后不能丢院校
if (schools.length !== schoolIdx.length) {
  throw new Error(`合并后院校数不一致：${schools.length} != ${schoolIdx.length}`);
}

// ---------- 分面统计 ----------
function facetCount(keyFn) {
  const m = {};
  for (const s of schools) {
    const keys = keyFn(s);
    for (const k of (Array.isArray(keys) ? keys : [keys])) {
      if (k == null || k === '') continue;
      m[k] = (m[k] || 0) + 1;
    }
  }
  return m;
}

const facets = {
  province: facetCount((s) => s.province),
  city: facetCount((s) => s.city),
  category: facetCount((s) => s.category),
  affiliation: facetCount((s) => s.affiliation),
  tags: facetCount((s) => s.tags),
  cityTier: filter.CITY_TIER,
};

// ---------- 专业库：反查开设院校 ----------
const majors = majorMod.map((m) => {
  const name = m.name;
  const schoolsOffering = schools
    .filter((s) => s.bachelorMajors.includes(name) || s.aceMajors.includes(name))
    .map((s) => ({ id: s.id, name: s.name, city: s.city, province: s.province, tags: s.tags }));
  return Object.assign({}, m, { schoolsOffering, schoolsCount: schoolsOffering.length });
});

// ---------- 一分一段 ----------
const score = {
  meta: scoreMod.meta || {},
  // score2025 结构在下面打印确认后处理
};

// score2025.js 结构探测
const scoreKeys = Object.keys(scoreMod);
let scoreRows = { phys: [], hist: [] };
if (Array.isArray(scoreMod)) {
  // 直接是数组：[{subject, score, count, rank}]
  for (const r of scoreMod) {
    const subj = r.subject === 'hist' ? 'hist' : 'phys';
    scoreRows[subj].push(r);
  }
} else if (scoreMod.rows) {
  scoreRows = scoreMod.rows;
} else if (scoreMod.phys || scoreMod.hist) {
  scoreRows = { phys: scoreMod.phys || [], hist: scoreMod.hist || [] };
}
const scoreMeta = scoreMod.meta || scoreMod.meta0 || {};
const scoreOut = {
  meta: Object.assign({ generatedAt: new Date().toISOString().slice(0, 10) }, scoreMeta),
  phys: scoreRows.phys,
  hist: scoreRows.hist,
};
console.log(`一分一段：物理 ${scoreOut.phys.length} 行/ 历史 ${scoreOut.hist.length} 行（源 keys=${scoreKeys.join(',')}）`);

// ---------- 写盘 ----------
fs.mkdirSync(OUT, { recursive: true });

function write(name, obj) {
  const p = path.join(OUT, name);
  const s = JSON.stringify(obj);
  fs.writeFileSync(p, s);
  console.log(`  ${name}  ${(s.length / 1024).toFixed(1)} KB`);
}

console.log('\n写出：');
write('schools.json', { meta: { generatedAt: new Date().toISOString().slice(0, 10), coverage: cov }, schools });
write('majors.json', { meta: { total: majors.length }, majors });
write('score2025.json', scoreOut);
write('facets.json', { meta: { coverage: cov }, facets });
write('config.json', {
  meta: { generatedAt: new Date().toISOString().slice(0, 10), coverage: cov },
  dimensions: filter.DIMENSIONS,
  defaultWeights: filter.DEFAULT_WEIGHTS,
  cityTier: filter.CITY_TIER,
  majorGroups: filter.MAJOR_GROUPS,
  categoryToGroup: filter.CATEGORY_TO_GROUP,
  majorKeywords: filter.MAJOR_KEYWORDS,
  kwToGroup: filter.KW_TO_GROUP,
});

// ---------- 覆盖率报告 ----------
console.log('\n数据覆盖率（诚实披露）：');
const rows = [
  ['院校基础信息', cov.total, cov.total],
  ['双一流学科', cov.doubleFirstClassDisciplines, cov.total],
  ['录取位次', cov.admissionRank, cov.total],
  ['保研率', cov.postgradRate, cov.total],
  ['专业设置', cov.bachelorMajors, cov.total],
  ['王牌专业', cov.aceMajors, cov.total],
  ['院校简介', cov.intro, cov.total],
  ['详细地址', cov.address, cov.total],
];
for (const [k, a, b] of rows) {
  const pct = ((a / b) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round((a / b) * 20)).padEnd(20, '░');
  console.log(`  ${k.padEnd(8)} ${String(a).padStart(4)}/${b}  ${bar} ${pct}%`);
}
console.log(`\n985 ${cov.tier985} · 211 ${cov.tier211} · 双一流 ${cov.tierDoubleFirstClass} · 省份 ${cov.provinces} · 城市 ${cov.cities} · 河南 ${cov.henanSchools}`);
/* ---------------------------------------------------------------------------
 * 资源指纹：把 app.css / app.js 的内容哈希写进 HTML 引用
 *
 * 不做这一步的话，GitHub Pages 会给浏览器下发长缓存的 app.js，
 * 我们改了代码但用户看到的还是旧版（本次踩过：改了一分一段表头，
 * 线上 fetch 已是新文件，页面却仍渲染旧文案）。
 * 内容哈希变化即文件名变化，浏览器自然重新拉取。
 * ------------------------------------------------------------------------- */
const SITE = path.join(__dirname, '..');
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(SITE, rel))).digest('hex').slice(0, 6);

const stamp = { 'assets/app.css': sha('assets/app.css'), 'assets/app.js': sha('assets/app.js') };
let touched = 0;
for (const name of fs.readdirSync(SITE).filter((f) => f.endsWith('.html'))) {
  const fp = path.join(SITE, name);
  const before = fs.readFileSync(fp, 'utf8');
  const after = before
    .replace(/href="assets\/app\.css(\?v=[^"]*)?"/, `href="assets/app.css?v=${stamp['assets/app.css']}"`)
    .replace(/src="assets\/app\.js(\?v=[^"]*)?"/, `src="assets/app.js?v=${stamp['assets/app.js']}"`);
  if (after !== before) { fs.writeFileSync(fp, after); touched++; }
}
console.log(`\n资源指纹已同步：css ${stamp['assets/app.css']} · js ${stamp['assets/app.js']}（${touched} 个页面）`);
