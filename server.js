const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const mysql = require("mysql2/promise");
const multer = require("multer");
const QRCode = require("qrcode");
const helmet = require("helmet");
const compression = require("compression");

const app = express();
const port = Number(process.env.PORT || 3000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const requiredEnv = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  charset: "utf8mb4",
});

const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  createDatabaseTable: true,
  schema: { tableName: "admin_sessions", columnNames: { session_id: "session_id", expires: "expires", data: "data" } },
});

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public", { maxAge: "1h" }));
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || "development-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 },
}));

app.use((req, res, next) => {
  if (req.method !== "POST" || !req.headers.origin) return next();
  try {
    const requestOrigin = new URL(req.headers.origin).origin;
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const allowedOrigins = new Set([
      new URL(publicBase()).origin,
      `${req.protocol}://${req.get("host")}`,
      forwardedHost ? `${forwardedProto}://${forwardedHost}` : "",
    ].filter(Boolean));
    if (!allowedOrigins.has(requestOrigin)) return res.status(403).send("Invalid request origin");
  } catch { return res.status(403).send("Invalid request origin"); }
  next();
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const id = () => crypto.randomUUID();
const languageName = (value) => value === "zh" ? "中文" : value === "ms" ? "Bahasa Melayu" : "English";
const publicBase = () => (process.env.PUBLIC_BASE_URL || "https://google-review.ryankey.com.my").replace(/\/$/, "");

const navItems = [
  ["overview", "/admin", "总览"],
  ["merchants", "/admin/merchants", "所有商家"],
  ["reviews", "/admin/reviews", "评价资料"],
  ["qr", "/admin/qr-codes", "QR Codes"],
  ["settings", "/admin/settings", "设置"],
];

function layout(title, content, options = {}) {
  const admin = options.admin;
  const active = options.active || "overview";
  const shell = admin ? `<div class="admin-shell"><aside class="sidebar"><a class="brand" href="/admin"><span class="brand-mark">R</span><span><b>REVIEW CONTROL</b><small>RyanKey Designs</small></span></a><nav>${navItems.map(([key, href, label]) => `<a class="nav-link ${active === key ? "active" : ""}" href="${href}">${label}</a>`).join("")}</nav><div class="sidebar-foot"><b>${escapeHtml(process.env.ADMIN_EMAIL || "Administrator")}</b><small>Platform Owner</small><form method="post" action="/logout"><button class="logout" type="submit">退出登录</button></form></div></aside><main class="admin-main">${content}</main></div>` : content;
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RyanKey Designs</title><meta name="description" content="Google Review Assistant by RyanKey Designs"><link rel="stylesheet" href="/style.css"></head><body>${shell}</body></html>`;
}

function requireAdmin(req, res, next) {
  if (req.session.admin === true) return next();
  res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
}

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/admin";
}

async function initDatabase() {
  if (missingEnv.length) throw new Error(`Missing environment variables: ${missingEnv.join(", ")}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS merchants (
    id CHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, slug VARCHAR(100) NOT NULL UNIQUE,
    industry VARCHAR(120) NOT NULL, language VARCHAR(5) NOT NULL DEFAULT 'zh',
    google_review_link TEXT NOT NULL, primary_color CHAR(7) NOT NULL DEFAULT '#2563EB',
    logo_mime VARCHAR(60) NULL, logo_data LONGBLOB NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS review_templates (
    id CHAR(36) PRIMARY KEY, merchant_id CHAR(36) NOT NULL, language VARCHAR(5) NOT NULL DEFAULT 'zh',
    content VARCHAR(500) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_template_merchant (merchant_id, active),
    CONSTRAINT fk_template_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
    id CHAR(36) PRIMARY KEY, merchant_id CHAR(36) NOT NULL, type ENUM('scan','generate','redirect') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_event_merchant_type (merchant_id, type),
    CONSTRAINT fk_event_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

const defaultTemplates = {
  zh: ["这次在【商家名称】的体验很好，工作人员服务亲切，整个过程都很顺利，值得推荐。", "【商家名称】的工作人员非常专业，也很有耐心，整体体验令人满意。", "第一次来到【商家名称】，环境舒适，服务也比预期更好，下次还会再来。", "感谢【商家名称】工作人员的细心协助，服务过程简单顺畅，让人感觉很放心。", "整体体验很好，工作人员友善又专业，有需要的话会再次选择【商家名称】。"],
  en: ["I had a pleasant experience with 【Business Name】. The team was friendly, helpful and professional.", "Great service from 【Business Name】. Everything was handled smoothly and the overall experience was satisfying.", "The staff at 【Business Name】 were patient and professional. I would be happy to visit again."],
  ms: ["Pengalaman saya di 【Business Name】 sangat baik. Kakitangannya mesra, membantu dan profesional.", "Perkhidmatan daripada 【Business Name】 sangat memuaskan dan semuanya berjalan lancar.", "Kakitangan 【Business Name】 sangat sabar dan profesional. Saya gembira untuk datang lagi."],
};

app.get("/health", asyncRoute(async (_req, res) => { await pool.query("SELECT 1"); res.json({ ok: true }); }));
app.get("/", (_req, res) => res.redirect("/admin"));

app.get("/login", (req, res) => {
  if (req.session.admin) return res.redirect("/admin");
  const error = req.query.error ? `<div class="notice error">电邮或密码不正确。</div>` : "";
  res.send(layout("管理员登录", `<main class="login-page"><section class="login-card"><span class="brand-mark large">R</span><p class="eyebrow">RYANKEY ADMIN</p><h1>管理后台登录</h1><p>统一管理所有商家、评价资料及 QR Code。</p>${error}<form method="post" action="/login" class="form-stack"><input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo(req.query.returnTo))}"><label>管理员电邮<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="button primary" type="submit">登录管理后台</button></form><small>Powered by RyanKey Designs</small></section></main>`));
});

app.post("/login", (req, res) => {
  const expectedEmail = String(process.env.ADMIN_EMAIL || "").toLowerCase();
  const email = String(req.body.email || "").toLowerCase();
  const password = String(req.body.password || "");
  const expectedPassword = String(process.env.ADMIN_PASSWORD || "");
  const emailOk = email.length === expectedEmail.length && crypto.timingSafeEqual(Buffer.from(email), Buffer.from(expectedEmail));
  const passwordOk = password.length === expectedPassword.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expectedPassword));
  if (!emailOk || !passwordOk) return res.redirect(`/login?error=1&returnTo=${encodeURIComponent(safeReturnTo(req.body.returnTo))}`);
  req.session.regenerate((error) => {
    if (error) return res.status(500).send("Unable to start session");
    req.session.admin = true;
    res.redirect(safeReturnTo(req.body.returnTo));
  });
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/admin", requireAdmin, asyncRoute(async (_req, res) => {
  const [[merchantCount], [eventRows], [recent]] = await Promise.all([
    pool.query("SELECT COUNT(*) total, SUM(active = 1) active FROM merchants"),
    pool.query("SELECT type, COUNT(*) total FROM events GROUP BY type"),
    pool.query("SELECT * FROM merchants ORDER BY created_at DESC LIMIT 8"),
  ]);
  const events = Object.fromEntries(eventRows.map((row) => [row.type, Number(row.total)]));
  const cards = [["所有商家", merchantCount[0]?.total || 0, `${merchantCount[0]?.active || 0} 个已启用`], ["QR 扫描", events.scan || 0, "评价页开启次数"], ["评价生成", events.generate || 0, "按钮点击次数"], ["Google 跳转", events.redirect || 0, "前往评论页面"]];
  const rows = recent.map((m) => `<tr><td><b>${escapeHtml(m.name)}</b><small>/r/${escapeHtml(m.slug)}</small></td><td>${escapeHtml(m.industry)}</td><td><span class="status ${m.active ? "on" : ""}">${m.active ? "已启用" : "已暂停"}</span></td><td class="actions"><a class="button small ghost" target="_blank" href="/r/${encodeURIComponent(m.slug)}">预览</a><a class="button small" href="/admin/merchants/${m.id}/edit">管理</a></td></tr>`).join("");
  res.send(layout("管理中心", `<header class="page-head"><div><p class="eyebrow">RYANKEY ADMIN / HOSTINGER</p><h1>Google Review 管理中心</h1><p>所有商家资料和互动数据都集中在这里。</p></div><a class="button primary" href="/admin/merchants/new">＋ 新增商家</a></header><section class="stats">${cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}</section><section class="panel"><div class="panel-head"><div><h2>最近商家</h2><p>管理商家资料、评价模板与 QR Code</p></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>商家</th><th>行业</th><th>状态</th><th class="right">操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><h2>还没有商家</h2><p>建立第一个商家后，系统会准备评价模板及 QR Code。</p></div>`}</section>`, { admin: true, active: "overview" }));
}));

app.get("/admin/merchants", requireAdmin, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query("SELECT * FROM merchants ORDER BY created_at DESC");
  const table = rows.map((m) => `<tr><td><b>${escapeHtml(m.name)}</b><small>/r/${escapeHtml(m.slug)}</small></td><td>${escapeHtml(m.industry)}</td><td>${languageName(m.language)}</td><td><span class="status ${m.active ? "on" : ""}">${m.active ? "已启用" : "已暂停"}</span></td><td class="actions"><a class="button small" href="/admin/merchants/${m.id}/edit">管理</a><form method="post" action="/admin/merchants/${m.id}/delete" onsubmit="return confirm('确定永久删除这个商家及其资料？')"><button class="button small danger" type="submit">删除</button></form></td></tr>`).join("");
  res.send(layout("所有商家", `<header class="page-head"><div><p class="eyebrow">MERCHANT DIRECTORY</p><h1>所有商家</h1><p>集中管理商家资料及启用状态。</p></div><a class="button primary" href="/admin/merchants/new">＋ 新增商家</a></header><section class="panel">${table ? `<div class="table-wrap"><table><thead><tr><th>商家</th><th>行业</th><th>语言</th><th>状态</th><th class="right">操作</th></tr></thead><tbody>${table}</tbody></table></div>` : `<div class="empty">还没有商家</div>`}</section>`, { admin: true, active: "merchants" }));
}));

function merchantForm(merchant = {}) {
  return `<div class="form-grid"><label>商家名称<input name="name" value="${escapeHtml(merchant.name)}" required></label><label>专属网址代号<input name="slug" value="${escapeHtml(merchant.slug)}" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required><small>只可使用小写英文、数字及连字符</small></label><label>商家行业<input name="industry" value="${escapeHtml(merchant.industry)}" required></label><label>评价语言<select name="language"><option value="zh" ${merchant.language === "zh" ? "selected" : ""}>中文</option><option value="en" ${merchant.language === "en" ? "selected" : ""}>English</option><option value="ms" ${merchant.language === "ms" ? "selected" : ""}>Bahasa Melayu</option></select></label><label class="full">官方 Google Review Link<input name="googleReviewLink" type="url" value="${escapeHtml(merchant.google_review_link)}" required></label><label>品牌颜色<input name="primaryColor" value="${escapeHtml(merchant.primary_color || "#2563EB")}" pattern="#[0-9A-Fa-f]{6}" required></label><label>商家 Logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG、JPG 或 WebP，最大 2MB</small></label></div><div class="form-actions"><label class="check"><input name="active" type="checkbox" value="1" ${merchant.active === 0 ? "" : "checked"}> 已启用</label><button class="button primary" type="submit">保存商家资料</button></div>`;
}

app.get("/admin/merchants/new", requireAdmin, (_req, res) => res.send(layout("新增商家", `<a class="back" href="/admin/merchants">← 返回所有商家</a><section class="panel form-panel"><p class="eyebrow">NEW MERCHANT</p><h1>新增商家</h1><p>建立商家后会自动加入评价模板并生成 QR Code。</p><form method="post" action="/admin/merchants" enctype="multipart/form-data">${merchantForm({ language: "zh", primary_color: "#2563EB", active: 1 })}</form></section>`, { admin: true, active: "merchants" })));

app.post("/admin/merchants", requireAdmin, upload.single("logo"), asyncRoute(async (req, res) => {
  const merchantId = id();
  const language = ["zh", "en", "ms"].includes(req.body.language) ? req.body.language : "zh";
  await pool.query("INSERT INTO merchants (id,name,slug,industry,language,google_review_link,primary_color,logo_mime,logo_data,active) VALUES (?,?,?,?,?,?,?,?,?,?)", [merchantId, req.body.name, req.body.slug, req.body.industry, language, req.body.googleReviewLink, req.body.primaryColor, req.file?.mimetype || null, req.file?.buffer || null, req.body.active ? 1 : 0]);
  for (const content of defaultTemplates[language]) await pool.query("INSERT INTO review_templates (id,merchant_id,language,content) VALUES (?,?,?,?)", [id(), merchantId, language, content]);
  res.redirect(`/admin/merchants/${merchantId}/edit?created=1`);
}));

app.get("/admin/merchants/:id/edit", requireAdmin, asyncRoute(async (req, res) => {
  const [[merchants], [templates], [stats]] = await Promise.all([
    pool.query("SELECT * FROM merchants WHERE id=? LIMIT 1", [req.params.id]),
    pool.query("SELECT * FROM review_templates WHERE merchant_id=? ORDER BY created_at DESC", [req.params.id]),
    pool.query("SELECT type, COUNT(*) total FROM events WHERE merchant_id=? GROUP BY type", [req.params.id]),
  ]);
  const merchant = merchants[0];
  if (!merchant) return res.status(404).send("Merchant not found");
  const statMap = Object.fromEntries(stats.map((row) => [row.type, Number(row.total)]));
  const qr = await QRCode.toDataURL(`${publicBase()}/r/${merchant.slug}`, { width: 360, margin: 2 });
  const templateRows = templates.map((t) => `<div class="template-row"><p>${escapeHtml(t.content)}</p><form method="post" action="/admin/templates/${t.id}/delete"><input type="hidden" name="merchantId" value="${merchant.id}"><button class="icon-danger" type="submit" aria-label="删除评价">×</button></form></div>`).join("");
  res.send(layout(merchant.name, `<a class="back" href="/admin/merchants">← 返回所有商家</a>${req.query.created ? `<div class="notice success">商家已经建立。</div>` : ""}<header class="page-head"><div><p class="eyebrow">MERCHANT CONTROL</p><h1>${escapeHtml(merchant.name)}</h1><p>管理品牌资料、评价内容和顾客入口。</p></div></header><div class="merchant-layout"><div><section class="panel form-panel"><h2>商家资料</h2><form method="post" action="/admin/merchants/${merchant.id}" enctype="multipart/form-data">${merchantForm(merchant)}</form></section><section class="panel form-panel"><h2>评价资料库</h2><form class="template-add" method="post" action="/admin/templates"><input type="hidden" name="merchantId" value="${merchant.id}"><input type="hidden" name="language" value="${merchant.language}"><textarea name="content" maxlength="500" required placeholder="输入评价模板，可使用【商家名称】。"></textarea><button class="button primary" type="submit">添加评价</button></form>${templateRows}</section></div><aside><section class="panel qr-card"><p class="eyebrow">MERCHANT QR</p><h2>专属 QR Code</h2><img src="${qr}" alt="${escapeHtml(merchant.name)} QR Code"><code>${publicBase()}/r/${escapeHtml(merchant.slug)}</code><a class="button primary" download="${escapeHtml(merchant.slug)}-qr.png" href="${qr}">下载 QR Code</a></section><section class="dark-card"><p class="eyebrow">LIVE DATA</p><h2>互动统计</h2><div><span><b>${statMap.scan || 0}</b><small>扫描</small></span><span><b>${statMap.generate || 0}</b><small>生成</small></span><span><b>${statMap.redirect || 0}</b><small>跳转</small></span></div></section></aside></div>`, { admin: true, active: "merchants" }));
}));

app.post("/admin/merchants/:id", requireAdmin, upload.single("logo"), asyncRoute(async (req, res) => {
  const params = [req.body.name, req.body.slug, req.body.industry, req.body.language, req.body.googleReviewLink, req.body.primaryColor, req.body.active ? 1 : 0];
  let sql = "UPDATE merchants SET name=?,slug=?,industry=?,language=?,google_review_link=?,primary_color=?,active=?";
  if (req.file) { sql += ",logo_mime=?,logo_data=?"; params.push(req.file.mimetype, req.file.buffer); }
  sql += " WHERE id=?"; params.push(req.params.id);
  await pool.query(sql, params);
  res.redirect(`/admin/merchants/${req.params.id}/edit?saved=1`);
}));

app.post("/admin/merchants/:id/delete", requireAdmin, asyncRoute(async (req, res) => { await pool.query("DELETE FROM merchants WHERE id=?", [req.params.id]); res.redirect("/admin/merchants"); }));
app.post("/admin/templates", requireAdmin, asyncRoute(async (req, res) => { await pool.query("INSERT INTO review_templates (id,merchant_id,language,content) VALUES (?,?,?,?)", [id(), req.body.merchantId, req.body.language, req.body.content]); res.redirect(`/admin/merchants/${req.body.merchantId}/edit`); }));
app.post("/admin/templates/:id/delete", requireAdmin, asyncRoute(async (req, res) => { await pool.query("DELETE FROM review_templates WHERE id=?", [req.params.id]); res.redirect(`/admin/merchants/${req.body.merchantId}/edit`); }));

app.get("/admin/reviews", requireAdmin, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query("SELECT m.id,m.name,m.language,COUNT(t.id) total FROM merchants m LEFT JOIN review_templates t ON t.merchant_id=m.id GROUP BY m.id ORDER BY m.created_at DESC");
  res.send(layout("评价资料", `<header class="page-head"><div><p class="eyebrow">REVIEW LIBRARY</p><h1>评价资料</h1><p>管理每个商家的评价内容。</p></div></header><section class="card-list">${rows.map((m) => `<article><div><h2>${escapeHtml(m.name)}</h2><p>${languageName(m.language)} · ${m.total} 段评价</p></div><a class="button" href="/admin/merchants/${m.id}/edit">管理评价</a></article>`).join("") || `<div class="empty">还没有商家</div>`}</section>`, { admin: true, active: "reviews" }));
}));

app.get("/admin/qr-codes", requireAdmin, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query("SELECT id,name,slug FROM merchants ORDER BY created_at DESC");
  const cards = await Promise.all(rows.map(async (m) => ({ ...m, qr: await QRCode.toDataURL(`${publicBase()}/r/${m.slug}`, { width: 320, margin: 2 }) })));
  res.send(layout("QR Codes", `<header class="page-head"><div><p class="eyebrow">QR DIRECTORY</p><h1>QR Codes</h1><p>预览或下载每个商家的顾客入口。</p></div></header><section class="qr-grid">${cards.map((m) => `<article class="panel qr-card"><h2>${escapeHtml(m.name)}</h2><img src="${m.qr}" alt="QR Code"><code>${publicBase()}/r/${escapeHtml(m.slug)}</code><a class="button primary" download="${escapeHtml(m.slug)}-qr.png" href="${m.qr}">下载</a></article>`).join("") || `<div class="empty">还没有商家</div>`}</section>`, { admin: true, active: "qr" }));
}));

app.get("/admin/settings", requireAdmin, (_req, res) => res.send(layout("设置", `<header class="page-head"><div><p class="eyebrow">PLATFORM SETTINGS</p><h1>设置</h1><p>平台状态与管理员安全。</p></div></header><section class="card-list"><article><div><h2>管理员账号</h2><p>通过 Hostinger 环境变量安全设定</p></div><b>${escapeHtml(process.env.ADMIN_EMAIL)}</b></article><article><div><h2>数据库</h2><p>Hostinger MySQL</p></div><span class="status on">已连接</span></article><article><div><h2>公开网址</h2><p>顾客评价页面使用的主网址</p></div><b>${escapeHtml(publicBase())}</b></article></section>`, { admin: true, active: "settings" })));

app.get("/media/:id", asyncRoute(async (req, res) => {
  const [rows] = await pool.query("SELECT logo_mime,logo_data FROM merchants WHERE id=? LIMIT 1", [req.params.id]);
  if (!rows[0]?.logo_data) return res.status(404).end();
  res.type(rows[0].logo_mime).send(rows[0].logo_data);
}));

app.get("/r/:slug", asyncRoute(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM merchants WHERE slug=? AND active=1 LIMIT 1", [req.params.slug]);
  const merchant = rows[0];
  if (!merchant) return res.status(404).send(layout("找不到商家", `<main class="public-page"><section class="review-card"><h1>找不到商家</h1><p>请检查 QR Code 或网址是否正确。</p></section></main>`));
  const [templates] = await pool.query("SELECT content FROM review_templates WHERE merchant_id=? AND active=1", [merchant.id]);
  await pool.query("INSERT INTO events (id,merchant_id,type) VALUES (?,?, 'scan')", [id(), merchant.id]);
  const texts = templates.map((t) => t.content.replaceAll("【商家名称】", merchant.name).replaceAll("【Business Name】", merchant.name));
  const copy = merchant.language === "en" ? { thanks: "Thank you for your support!", intro: "Tap the button and we will prepare a review draft for you.", button: "Generate review and go to Google", copied: "Review copied ✓", hint: "On Google Reviews, press and hold to paste your review.", policy: "The generated text is for reference only. Please edit it based on your genuine experience and choose an appropriate rating.", fallback: "Your browser could not copy automatically. Press and hold the review below to copy it.", go: "Go to Google Review" } : merchant.language === "ms" ? { thanks: "Terima kasih atas sokongan anda!", intro: "Tekan butang dan kami akan menyediakan draf ulasan.", button: "Jana ulasan dan pergi ke Google", copied: "Ulasan telah disalin ✓", hint: "Di Google Reviews, tekan lama untuk menampal ulasan.", policy: "Teks ini hanya sebagai rujukan. Sila ubah berdasarkan pengalaman sebenar dan pilih penilaian yang sesuai.", fallback: "Pelayar anda tidak dapat menyalin secara automatik. Tekan lama teks di bawah untuk menyalinnya.", go: "Pergi ke Google Review" } : { thanks: "感谢您的支持！", intro: "轻按下面的按钮，我们会帮您整理一段评价。", button: "生成评价并前往 Google", copied: "评价已复制 ✓", hint: "前往 Google Review 后，请长按并粘贴评价。", policy: "系统生成的文字仅供参考，请根据您的真实体验进行修改，并自行选择适合的评分。", fallback: "您的浏览器无法自动复制，请长按下面的评价并选择复制。", go: "前往 Google Review" };
  res.send(layout(merchant.name, `<main class="public-page"><section class="review-card" style="--brand:${escapeHtml(merchant.primary_color)}">${merchant.logo_data ? `<img class="merchant-logo" src="/media/${merchant.id}" alt="${escapeHtml(merchant.name)} Logo">` : `<div class="merchant-logo placeholder">R</div>`}<p class="eyebrow">GOOGLE REVIEW ASSISTANT</p><h1>${escapeHtml(merchant.name)}</h1><h2>${copy.thanks}</h2><p>${copy.intro}</p><button id="generate" class="review-button">${copy.button}<span>→</span></button><p id="hint" class="hint" hidden>${copy.hint}</p><div id="fallback" class="fallback" hidden><p>${copy.fallback}</p><blockquote id="reviewText"></blockquote><a href="${escapeHtml(merchant.google_review_link)}">${copy.go}</a></div><p class="policy">${copy.policy}</p></section><footer>Powered by <a href="https://ryankey.com.my/">RyanKey Designs</a></footer></main><script>const templates=${JSON.stringify(texts).replace(/</g, "\\u003c")};const merchantId=${JSON.stringify(merchant.id)};const reviewLink=${JSON.stringify(merchant.google_review_link)};const button=document.getElementById('generate');const hint=document.getElementById('hint');const fallback=document.getElementById('fallback');const reviewText=document.getElementById('reviewText');async function event(type){try{await fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchantId,type})})}catch{}}button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;const text=templates[Math.floor(Math.random()*templates.length)]||${JSON.stringify(copy.policy)};try{await navigator.clipboard.writeText(text);button.textContent=${JSON.stringify(copy.copied)};hint.hidden=false;event('generate');setTimeout(()=>{event('redirect');location.href=reviewLink},1300)}catch{reviewText.textContent=text;fallback.hidden=false;button.disabled=false;}});</script>`));
}));

app.post("/api/events", asyncRoute(async (req, res) => {
  if (!["generate", "redirect"].includes(req.body.type) || !req.body.merchantId) return res.status(400).json({ ok: false });
  await pool.query("INSERT INTO events (id,merchant_id,type) VALUES (?,?,?)", [id(), req.body.merchantId, req.body.type]);
  res.json({ ok: true });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  const message = error?.code === "ER_DUP_ENTRY" ? "网址代号已经被使用，请更换后再试。" : "系统暂时无法完成操作，请稍后重试。";
  res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).send(layout("系统提示", `<main class="login-page"><section class="login-card"><h1>${message}</h1><a class="button primary" href="/admin">返回管理后台</a></section></main>`));
});

initDatabase().then(() => app.listen(port, "0.0.0.0", () => console.log(`Google Review Assistant listening on ${port}`))).catch((error) => { console.error(error); process.exit(1); });
