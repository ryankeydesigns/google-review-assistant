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

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const id = () => crypto.randomUUID();
const languageName = (value) => value === "zh" ? "中文" : value === "ms" ? "Bahasa Melayu" : "English";
const publicBase = () => (process.env.PUBLIC_BASE_URL || "https://google-review.ryankey.com.my").replace(/\/$/, "");
const adminWhatsapp = () => String(process.env.ADMIN_WHATSAPP_NUMBER || "").replace(/\D/g, "");
const whatsappNumber = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.startsWith("0") ? `60${digits.slice(1)}` : digits;
};
const merchantPortalPath = (merchant, suffix = "") => `/client/${encodeURIComponent(merchant.slug)}${suffix}`;
const clientLogins = (req) => {
  const stored = req.session.clientLogins;
  return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
};
const isClientLoggedIn = (req, merchant) => clientLogins(req)[merchant.slug] === merchant.id || req.session.clientMerchantId === merchant.id;
const rememberClientLogin = (req, merchant) => {
  req.session.clientLogins = { ...clientLogins(req), [merchant.slug]: merchant.id };
  req.session.lastClientSlug = merchant.slug;
  delete req.session.clientMerchantId;
};

const navItems = [
  ["overview", "/admin", "总览"],
  ["merchants", "/admin/merchants", "所有商家"],
  ["reviews", "/admin/reviews", "评价资料"],
  ["reports", "/admin/reports", "客户报告"],
  ["analytics", "/admin/analytics", "使用量分析"],
  ["billing", "/admin/billing", "点数收费"],
  ["qr", "/admin/qr-codes", "QR Codes"],
  ["settings", "/admin/settings", "设置"],
];
const clientNavItems = [
  ["dashboard", "", "主页"],
  ["merchant", "/merchant", "商家资料"],
  ["reviews", "/reviews", "评价资料库"],
  ["reports", "/reports", "客户报告"],
];

const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit" }).format(new Date());
const validMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || "")) ? String(value) : currentMonth();
const monthBounds = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return [new Date(`${month}-01T00:00:00+08:00`), new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`)];
};
const formatDateTime = (value) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
const csvCell = (value) => {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
};
const usageLabel = (value) => ({ visit: "客户进入", review_generated: "生成评价", review_added: "新增评价", topup: "充值", topup_request: "充值申请" }[value] || value);
const analyticsPeriods = {
  day: { title: "每日", count: 30, sqlFormat: "%Y-%m-%d" },
  month: { title: "每月", count: 12, sqlFormat: "%Y-%m" },
  year: { title: "每年", count: 5, sqlFormat: "%Y" },
};
const topupPackages = {
  "100": { amount: 100, bonus: 0, points: 100 },
  "500": { amount: 500, bonus: 50, points: 550 },
  "800": { amount: 800, bonus: 80, points: 880 },
  "1000": { amount: 1000, bonus: 100, points: 1100 },
  "1200": { amount: 1200, bonus: 240, points: 1440 },
};
const visitorHash = (req) => crypto.createHash("sha256").update(`${req.ip}|${req.get("user-agent") || ""}|${process.env.SESSION_SECRET}`).digest("hex");
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
};
const verifyPassword = (password, storedHash) => {
  const [algorithm, salt, expectedHex] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

function analyticsBuckets(period) {
  const selected = analyticsPeriods[period] || analyticsPeriods.month;
  const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const keys = [];
  for (let offset = selected.count - 1; offset >= 0; offset -= 1) {
    if (period === "day") {
      const date = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day - offset));
      keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`);
    } else if (period === "year") {
      keys.push(String(nowParts.year - offset));
    } else {
      const date = new Date(Date.UTC(nowParts.year, nowParts.month - 1 - offset, 1));
      keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
    }
  }
  const firstKey = keys[0];
  const start = new Date(`${period === "year" ? `${firstKey}-01-01` : period === "day" ? firstKey : `${firstKey}-01`}T00:00:00+08:00`);
  const labels = keys.map((key) => period === "day" ? `${key.slice(5, 7)}/${key.slice(8, 10)}` : period === "month" ? key : `${key}年`);
  return { ...selected, keys, labels, start };
}

function chartPath(points) {
  if (!points.length) return "";
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous[0] + current[0]) / 2;
    path += ` C ${middle} ${previous[1]}, ${middle} ${current[1]}, ${current[0]} ${current[1]}`;
  }
  return path;
}

function lineChart(labels, series, options = {}) {
  const width = 960;
  const height = 320;
  const left = 58;
  const right = 24;
  const top = 30;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const allValues = series.flatMap((item) => item.values.map((value) => Number(value) || 0));
  const maxValue = Math.max(options.minimumMax || 1, ...allValues);
  const x = (index) => left + (labels.length <= 1 ? plotWidth / 2 : index * plotWidth / (labels.length - 1));
  const y = (value) => top + plotHeight - ((Number(value) || 0) / maxValue) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maxValue * (4 - index) / 4;
    const yPos = top + index * plotHeight / 4;
    const label = options.percent ? `${Math.round(value)}%` : Math.round(value).toLocaleString("en-MY");
    return `<line x1="${left}" y1="${yPos}" x2="${width - right}" y2="${yPos}"/><text x="${left - 10}" y="${yPos + 4}" text-anchor="end">${label}</text>`;
  }).join("");
  const labelStep = Math.max(1, Math.ceil(labels.length / 7));
  const xLabels = labels.map((label, index) => (index % labelStep === 0 || index === labels.length - 1) ? `<text x="${x(index)}" y="${height - 18}" text-anchor="middle">${escapeHtml(label)}</text>` : "").join("");
  const lines = series.map((item) => {
    const points = item.values.map((value, index) => [x(index), y(value)]);
    const dots = points.map((point, index) => `<circle cx="${point[0]}" cy="${point[1]}" r="3.5"><title>${escapeHtml(labels[index])} · ${escapeHtml(item.name)}：${Number(item.values[index]).toLocaleString("en-MY")}${options.percent ? "%" : ""}</title></circle>`).join("");
    return `<g class="chart-series" style="--series:${item.color}"><path d="${chartPath(points)}"/>${dots}</g>`;
  }).join("");
  const legend = series.map((item) => `<span><i style="background:${item.color}"></i>${escapeHtml(item.name)}</span>`).join("");
  return `<div class="chart-legend">${legend}</div><div class="chart-scroll"><svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "数据趋势图")}"><g class="chart-grid">${grid}${xLabels}</g>${lines}</svg></div>`;
}

function layout(title, content, options = {}) {
  const admin = options.admin;
  const client = options.client;
  const active = options.active || "overview";
  const documentLanguage = options.lang || "zh-Hans";
  let shell = content;
  if (admin) shell = `<div class="admin-shell"><aside class="sidebar"><a class="brand" href="/admin"><span class="brand-mark">R</span><span><b>REVIEW CONTROL</b><small>RyanKey Designs</small></span></a><nav>${navItems.map(([key, href, label]) => `<a class="nav-link ${active === key ? "active" : ""}" href="${href}">${label}</a>`).join("")}</nav><div class="sidebar-foot"><b>${escapeHtml(process.env.ADMIN_EMAIL || "Administrator")}</b><small>Platform Owner</small><form method="post" action="/logout"><button class="logout" type="submit">退出登录</button></form></div></aside><main class="admin-main">${content}</main></div>`;
  if (client) {
    const clientBase = merchantPortalPath(client);
    shell = `<div class="admin-shell client-shell"><aside class="sidebar"><a class="brand" href="${clientBase}"><span class="brand-mark">R</span><span><b>MERCHANT PORTAL</b><small>Google Review Assistant</small></span></a><nav>${clientNavItems.map(([key, suffix, label]) => `<a class="nav-link ${active === key ? "active" : ""}" href="${clientBase}${suffix}">${label}</a>`).join("")}</nav><div class="sidebar-foot"><b>${escapeHtml(client.name)}</b><small>${escapeHtml(client.client_email || "Client Account")}</small><form method="post" action="${clientBase}/logout"><button class="logout" type="submit">退出登录</button></form></div></aside><main class="admin-main">${content}</main></div>`;
  }
  return `<!doctype html><html lang="${documentLanguage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RyanKey Designs</title><meta name="description" content="Google Review Assistant by RyanKey Designs"><meta name="theme-color" content="#2563EB"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" type="image/png" sizes="512x512" href="/site-icon.png?v=2"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2"><link rel="stylesheet" href="/style.css?v=13"></head><body>${shell}</body></html>`;
}

function requireAdmin(req, res, next) {
  if (req.session.admin === true) return next();
  res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
}

const requireClient = asyncRoute(async (req, res, next) => {
  const [rows] = await pool.query("SELECT * FROM merchants WHERE slug=? AND active=1 LIMIT 1", [req.params.slug]);
  const merchant = rows[0];
  if (!merchant) return res.status(404).send(layout("找不到商家后台", `<main class="login-page"><section class="login-card"><h1>找不到商家后台</h1><p>请向平台管理员索取正确的专属网址。</p></section></main>`));
  if (!isClientLoggedIn(req, merchant)) return res.redirect(`${merchantPortalPath(merchant)}?returnTo=${encodeURIComponent(req.originalUrl)}`);
  if (req.session.clientMerchantId === merchant.id) rememberClientLogin(req, merchant);
  req.clientMerchant = merchant;
  next();
});

function clearClientLogin(req, res) {
  const logins = clientLogins(req);
  if (req.params.slug) delete logins[req.params.slug];
  req.session.clientLogins = logins;
  if (req.session.lastClientSlug === req.params.slug) delete req.session.lastClientSlug;
  if (!req.clientMerchant || req.session.clientMerchantId === req.clientMerchant.id) delete req.session.clientMerchantId;
  const back = req.params.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug) ? `/client/${req.params.slug}` : "/client";
  req.session.save(() => res.redirect(back));
}

async function getClientMerchant(req) {
  if (req.clientMerchant) return req.clientMerchant;
  const merchantId = clientLogins(req)[req.params.slug];
  if (!merchantId) return null;
  const [rows] = await pool.query("SELECT * FROM merchants WHERE id=? LIMIT 1", [merchantId]);
  return rows[0] || null;
}

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/admin";
}
function safeClientReturnTo(value, slug) {
  const clientBase = `/client/${slug}`;
  return typeof value === "string" && (value === clientBase || value.startsWith(`${clientBase}/`)) ? value : clientBase;
}

async function initDatabase() {
  if (missingEnv.length) throw new Error(`Missing environment variables: ${missingEnv.join(", ")}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS merchants (
    id CHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, slug VARCHAR(100) NOT NULL UNIQUE,
    industry VARCHAR(120) NOT NULL, language VARCHAR(5) NOT NULL DEFAULT 'zh',
    google_review_link TEXT NOT NULL, primary_color CHAR(7) NOT NULL DEFAULT '#2563EB',
    client_email VARCHAR(190) NULL, client_phone VARCHAR(30) NULL, client_password_hash VARCHAR(255) NULL,
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
  await pool.query(`CREATE TABLE IF NOT EXISTS usage_ledger (
    id CHAR(36) PRIMARY KEY, merchant_id CHAR(36) NOT NULL,
    event_type VARCHAR(30) NOT NULL, language VARCHAR(5) NULL,
    review_text VARCHAR(500) NULL, points_delta INT NOT NULL DEFAULT 0,
    visitor_hash CHAR(64) NULL, note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_usage_merchant_date (merchant_id, created_at),
    INDEX idx_usage_type_date (event_type, created_at),
    CONSTRAINT fk_usage_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const [merchantColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='merchants' AND COLUMN_NAME IN ('client_email','client_phone','client_password_hash')", [process.env.DB_NAME]);
  const existingColumns = new Set(merchantColumns.map((column) => column.COLUMN_NAME));
  if (!existingColumns.has("client_email")) await pool.query("ALTER TABLE merchants ADD COLUMN client_email VARCHAR(190) NULL AFTER primary_color");
  if (!existingColumns.has("client_phone")) await pool.query("ALTER TABLE merchants ADD COLUMN client_phone VARCHAR(30) NULL AFTER client_email");
  if (!existingColumns.has("client_password_hash")) await pool.query("ALTER TABLE merchants ADD COLUMN client_password_hash VARCHAR(255) NULL AFTER client_email");
  const [accountIndexes] = await pool.query("SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='merchants' AND INDEX_NAME='uq_merchants_client_email'", [process.env.DB_NAME]);
  if (!accountIndexes.length) await pool.query("ALTER TABLE merchants ADD UNIQUE INDEX uq_merchants_client_email (client_email)");
}

const defaultTemplates = {
  zh: ["这次在【商家名称】的体验很好，工作人员服务亲切，整个过程都很顺利，值得推荐。", "【商家名称】的工作人员非常专业，也很有耐心，整体体验令人满意。", "第一次来到【商家名称】，环境舒适，服务也比预期更好，下次还会再来。", "感谢【商家名称】工作人员的细心协助，服务过程简单顺畅，让人感觉很放心。", "整体体验很好，工作人员友善又专业，有需要的话会再次选择【商家名称】。"],
  en: ["I had a pleasant experience with 【Business Name】. The team was friendly, helpful and professional.", "Great service from 【Business Name】. Everything was handled smoothly and the overall experience was satisfying.", "The staff at 【Business Name】 were patient and professional. I would be happy to visit again."],
  ms: ["Pengalaman saya di 【Business Name】 sangat baik. Kakitangannya mesra, membantu dan profesional.", "Perkhidmatan daripada 【Business Name】 sangat memuaskan dan semuanya berjalan lancar.", "Kakitangan 【Business Name】 sangat sabar dan profesional. Saya gembira untuk datang lagi."],
};

async function ensureAllTemplateLanguages() {
  const [merchants] = await pool.query("SELECT id FROM merchants");
  for (const merchant of merchants) {
    const [counts] = await pool.query("SELECT language, COUNT(*) total FROM review_templates WHERE merchant_id=? GROUP BY language", [merchant.id]);
    const existing = new Set(counts.filter((row) => Number(row.total) > 0).map((row) => row.language));
    for (const language of ["en", "zh", "ms"]) {
      if (existing.has(language)) continue;
      for (const content of defaultTemplates[language]) {
        await pool.query("INSERT INTO review_templates (id,merchant_id,language,content) VALUES (?,?,?,?)", [id(), merchant.id, language, content]);
      }
    }
  }
}

async function normalizeReviewAdditionCharges() {
  const [rows] = await pool.query("SELECT id,merchant_id FROM usage_ledger WHERE event_type='review_added' ORDER BY merchant_id,created_at,id");
  const counters = new Map();
  for (const row of rows) {
    const additionNumber = (counters.get(row.merchant_id) || 0) + 1;
    counters.set(row.merchant_id, additionNumber);
    const points = additionNumber <= 3 ? 0 : -10;
    const note = additionNumber <= 3 ? `第 ${additionNumber} 条自定义评价（免费）` : `第 ${additionNumber} 条自定义评价（扣10分）`;
    await pool.query("UPDATE usage_ledger SET points_delta=?,note=? WHERE id=?", [points, note, row.id]);
  }
}

async function normalizeGenerationCharges() {
  await pool.query("UPDATE usage_ledger SET points_delta=0,note='客户进入评价页面（仅统计）' WHERE event_type='visit' AND points_delta<>0");
  await pool.query("UPDATE usage_ledger SET points_delta=-1,note='客户生成评价（扣1分）' WHERE event_type='review_generated' AND points_delta<>-1");
}

async function addCustomReviewTemplate(merchantId, language, content) {
  const selectedLanguage = ["en", "zh", "ms"].includes(language) ? language : "en";
  const reviewContent = String(content || "").trim().slice(0, 500);
  if (!reviewContent) throw new Error("Review content is required");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("SELECT id FROM merchants WHERE id=? FOR UPDATE", [merchantId]);
    const [balanceRows] = await connection.query("SELECT COALESCE(SUM(points_delta),0) balance FROM usage_ledger WHERE merchant_id=?", [merchantId]);
    if (Number(balanceRows[0]?.balance || 0) <= 10) {
      const error = new Error("Merchant balance is too low");
      error.code = "LOW_BALANCE";
      throw error;
    }
    const [countRows] = await connection.query("SELECT COUNT(*) total FROM usage_ledger WHERE merchant_id=? AND event_type='review_added'", [merchantId]);
    const additionNumber = Number(countRows[0]?.total || 0) + 1;
    const points = additionNumber <= 3 ? 0 : -10;
    const note = additionNumber <= 3 ? `第 ${additionNumber} 条自定义评价（免费）` : `第 ${additionNumber} 条自定义评价（扣10分）`;
    await connection.query("INSERT INTO review_templates (id,merchant_id,language,content) VALUES (?,?,?,?)", [id(), merchantId, selectedLanguage, reviewContent]);
    await connection.query("INSERT INTO usage_ledger (id,merchant_id,event_type,language,review_text,points_delta,note) VALUES (?,?,?,?,?,?,?)", [id(), merchantId, "review_added", selectedLanguage, reviewContent, points, note]);
    await connection.commit();
    return { additionNumber, points };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function validationError(res, message, back = "/admin/merchants") {
  return res.status(400).send(layout("资料未保存", `<main class="login-page"><section class="login-card"><h1>资料未保存</h1><p>${escapeHtml(message)}</p><a class="button primary" href="${escapeHtml(back)}">返回修改</a></section></main>`));
}

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
  const savedClientLogins = clientLogins(req);
  const lastClientSlug = req.session.lastClientSlug;
  const legacyClientMerchantId = req.session.clientMerchantId;
  req.session.regenerate((error) => {
    if (error) return res.status(500).send("Unable to start session");
    req.session.admin = true;
    if (Object.keys(savedClientLogins).length) req.session.clientLogins = savedClientLogins;
    if (lastClientSlug) req.session.lastClientSlug = lastClientSlug;
    if (legacyClientMerchantId) req.session.clientMerchantId = legacyClientMerchantId;
    res.redirect(safeReturnTo(req.body.returnTo));
  });
});

app.post("/logout", (req, res) => {
  delete req.session.admin;
  req.session.save(() => res.redirect("/login"));
});

function clientLoginMarkup(req, merchant) {
  const loginPath = merchantPortalPath(merchant);
  const error = req.query.error ? `<div class="notice error">客户电邮或密码不正确。</div>` : "";
  return layout(`${merchant.name} 客户登录`, `<main class="login-page"><section class="login-card"><span class="brand-mark large">R</span><p class="eyebrow">MERCHANT PORTAL</p><h1>${escapeHtml(merchant.name)} 客户登录</h1><p>这是 ${escapeHtml(merchant.name)} 的专属后台。登录后可管理商家资料、评价资料库及客户报告。</p>${error}<form method="post" action="${loginPath}/login" class="form-stack"><input type="hidden" name="returnTo" value="${escapeHtml(safeClientReturnTo(req.query.returnTo, merchant.slug))}"><label>客户电邮<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="button primary" type="submit">登录客户主页</button></form><small>专属网址：${escapeHtml(loginPath)} · Powered by RyanKey Designs</small></section></main>`);
}

app.get("/client/login", (req, res) => {
  res.redirect("/client");
});

app.get("/client/login/:slug", asyncRoute(async (req, res) => {
  res.redirect(301, `/client/${encodeURIComponent(req.params.slug)}`);
}));

app.post("/client/:slug/login", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const [rows] = await pool.query("SELECT id,name,slug,client_password_hash FROM merchants WHERE slug=? AND active=1 AND LOWER(client_email)=? LIMIT 1", [req.params.slug, email]);
  const merchant = rows[0];
  if (!merchant || !verifyPassword(req.body.password, merchant.client_password_hash)) return res.redirect(`/client/${encodeURIComponent(req.params.slug)}?error=1&returnTo=${encodeURIComponent(safeClientReturnTo(req.body.returnTo, req.params.slug))}`);
  const admin = req.session.admin === true;
  const savedClientLogins = clientLogins(req);
  const legacyClientMerchantId = req.session.clientMerchantId;
  req.session.regenerate((error) => {
    if (error) return res.status(500).send("Unable to start session");
    req.session.clientLogins = savedClientLogins;
    rememberClientLogin(req, merchant);
    if (legacyClientMerchantId && legacyClientMerchantId !== merchant.id) req.session.clientMerchantId = legacyClientMerchantId;
    if (admin) req.session.admin = true;
    res.redirect(safeClientReturnTo(req.body.returnTo, merchant.slug));
  });
}));

app.post("/client/:slug/logout", requireClient, (req, res) => {
  clearClientLogin(req, res);
});

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

app.get("/admin/analytics", requireAdmin, asyncRoute(async (req, res) => {
  const period = Object.hasOwn(analyticsPeriods, req.query.period) ? req.query.period : "month";
  const buckets = analyticsBuckets(period);
  const [[activityRows], [joinRows], [baselineRows], [merchantRows]] = await Promise.all([
    pool.query(`SELECT DATE_FORMAT(created_at, ?) bucket,
      COUNT(CASE WHEN event_type='visit' THEN 1 END) visits,
      COUNT(CASE WHEN event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN event_type='review_added' THEN 1 END) reviews_added,
      COUNT(DISTINCT CASE WHEN event_type='review_added' THEN merchant_id END) merchants_adding,
      COUNT(DISTINCT CASE WHEN event_type='topup' THEN merchant_id END) merchants_topping_up
      FROM usage_ledger WHERE created_at>=? GROUP BY bucket ORDER BY bucket`, [buckets.sqlFormat, buckets.start]),
    pool.query("SELECT DATE_FORMAT(created_at, ?) bucket,COUNT(*) total FROM merchants WHERE created_at>=? GROUP BY bucket ORDER BY bucket", [buckets.sqlFormat, buckets.start]),
    pool.query("SELECT COUNT(*) total FROM merchants WHERE created_at<?", [buckets.start]),
    pool.query(`SELECT m.id,m.name,
      COUNT(CASE WHEN u.event_type='visit' THEN 1 END) visits,
      COUNT(CASE WHEN u.event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN u.event_type='review_added' THEN 1 END) reviews_added
      FROM merchants m LEFT JOIN usage_ledger u ON u.merchant_id=m.id AND u.created_at>=?
      GROUP BY m.id,m.name ORDER BY visits DESC,generated DESC,reviews_added DESC LIMIT 10`, [buckets.start]),
  ]);
  const activityByBucket = new Map(activityRows.map((row) => [String(row.bucket), row]));
  const joinsByBucket = new Map(joinRows.map((row) => [String(row.bucket), Number(row.total) || 0]));
  const visits = buckets.keys.map((key) => Number(activityByBucket.get(key)?.visits) || 0);
  const generated = buckets.keys.map((key) => Number(activityByBucket.get(key)?.generated) || 0);
  const reviewsAdded = buckets.keys.map((key) => Number(activityByBucket.get(key)?.reviews_added) || 0);
  const merchantTotals = [];
  let runningMerchants = Number(baselineRows[0]?.total) || 0;
  for (const key of buckets.keys) {
    runningMerchants += joinsByBucket.get(key) || 0;
    merchantTotals.push(runningMerchants);
  }
  const generatedRate = buckets.keys.map((key, index) => visits[index] ? Math.round(generated[index] / visits[index] * 1000) / 10 : 0);
  const additionRate = buckets.keys.map((key, index) => {
    const adding = Number(activityByBucket.get(key)?.merchants_adding) || 0;
    return merchantTotals[index] ? Math.round(adding / merchantTotals[index] * 1000) / 10 : 0;
  });
  const topupRate = buckets.keys.map((key, index) => {
    const toppingUp = Number(activityByBucket.get(key)?.merchants_topping_up) || 0;
    return merchantTotals[index] ? Math.round(toppingUp / merchantTotals[index] * 1000) / 10 : 0;
  });
  const totalVisits = visits.reduce((sum, value) => sum + value, 0);
  const totalGenerated = generated.reduce((sum, value) => sum + value, 0);
  const totalAdded = reviewsAdded.reduce((sum, value) => sum + value, 0);
  const joined = joinRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
  const cards = [
    ["商家使用量", totalVisits, `${buckets.title}范围内客户进入次数`],
    ["生成评价", totalGenerated, `${totalVisits ? Math.round(totalGenerated / totalVisits * 1000) / 10 : 0}% 评价生成率`],
    ["商家加入增长", joined, `目前共 ${merchantTotals.at(-1) || 0} 个商家`],
    ["新增评价", totalAdded, "商家加入资料库的评价"],
  ];
  const activityChart = lineChart(buckets.labels, [
    { name: "客户进入", color: "#2563eb", values: visits },
    { name: "生成评价", color: "#7c3aed", values: generated },
  ], { label: `${buckets.title}使用成绩增长` });
  const growthChart = lineChart(buckets.labels, [
    { name: "商家总数", color: "#0891b2", values: merchantTotals },
  ], { label: `${buckets.title}商家加入增长` });
  const rateChart = lineChart(buckets.labels, [
    { name: "评价生成率", color: "#16a34a", values: generatedRate },
    { name: "商家新增评价率", color: "#f59e0b", values: additionRate },
    { name: "客户充值率", color: "#e11d48", values: topupRate },
  ], { label: `${buckets.title}商家使用、新增评价及客户充值率`, percent: true, minimumMax: 100 });
  const merchantUsage = merchantRows.map((merchant) => ({
    ...merchant,
    visits: Number(merchant.visits) || 0,
    generated: Number(merchant.generated) || 0,
    reviewsAdded: Number(merchant.reviews_added) || 0,
  }));
  const maxMerchantUsage = Math.max(1, ...merchantUsage.map((merchant) => merchant.visits + merchant.generated));
  const usageBars = merchantUsage.map((merchant) => {
    const usage = merchant.visits + merchant.generated;
    const width = Math.max(usage ? 3 : 0, Math.round(usage / maxMerchantUsage * 100));
    return `<article class="usage-bar-row"><div><b>${escapeHtml(merchant.name)}</b><span>进入 ${merchant.visits} · 生成 ${merchant.generated} · 新增 ${merchant.reviewsAdded}</span></div><div class="usage-track"><i style="width:${width}%"></i></div><strong>${usage}</strong></article>`;
  }).join("");
  const periodTabs = Object.entries(analyticsPeriods).map(([key, item]) => `<a class="period-tab ${period === key ? "active" : ""}" href="/admin/analytics?period=${key}">${item.title}</a>`).join("");
  res.send(layout("使用量分析", `<header class="page-head analytics-head"><div><p class="eyebrow">USAGE ANALYTICS</p><h1>使用量分析</h1><p>追踪平台成绩、商家使用量、商家增长、评价资料库使用率及客户充值率。</p></div><nav class="period-tabs" aria-label="统计周期">${periodTabs}</nav></header><section class="stats analytics-stats">${cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${Number(value).toLocaleString("en-MY")}</strong><small>${note}</small></article>`).join("")}</section><section class="analytics-grid"><article class="panel chart-panel"><div class="panel-head"><h2>${buckets.title}成绩增长</h2><p>客户进入与生成评价的变化曲线</p></div>${activityChart}</article><article class="panel chart-panel"><div class="panel-head"><h2>商家加入增长</h2><p>商家总数累计成长曲线</p></div>${growthChart}</article><article class="panel chart-panel wide"><div class="panel-head"><h2>商家使用／添加评价／客户充值率</h2><p>评价生成率＝生成次数 ÷ 客户进入；新增评价率＝有新增评价的商家 ÷ 商家总数；充值率＝完成充值的商家 ÷ 商家总数</p></div>${rateChart}</article><article class="panel merchant-usage-panel wide"><div class="panel-head"><h2>商家使用量排行</h2><p>${buckets.title}范围内，以客户进入及生成评价次数计算</p></div><div class="usage-bars">${usageBars || `<div class="empty">目前还没有商家数据</div>`}</div></article></section>`, { admin: true, active: "analytics" }));
}));

app.get("/admin/merchants", requireAdmin, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query("SELECT * FROM merchants ORDER BY created_at DESC");
  const table = rows.map((m) => `<tr><td><b>${escapeHtml(m.name)}</b><small>/r/${escapeHtml(m.slug)}</small></td><td>${escapeHtml(m.industry)}</td><td>${m.client_email ? escapeHtml(m.client_email) : `<span class="status">未设置</span>`}</td><td><span class="status ${m.active ? "on" : ""}">${m.active ? "已启用" : "已暂停"}</span></td><td class="actions"><a class="button small ghost" target="_blank" href="/r/${encodeURIComponent(m.slug)}">预览</a><a class="button small" href="/admin/merchants/${m.id}/edit">管理客户</a><form method="post" action="/admin/merchants/${m.id}/delete" onsubmit="return confirm('确定永久删除这个商家及其资料？')"><button class="button small danger" type="submit">删除</button></form></td></tr>`).join("");
  res.send(layout("所有商家", `<header class="page-head"><div><p class="eyebrow">MERCHANT DIRECTORY</p><h1>所有商家</h1><p>集中管理商家资料、客户登录账号及启用状态。</p></div><a class="button primary" href="/admin/merchants/new">＋ 新增商家</a></header><section class="panel">${table ? `<div class="table-wrap"><table><thead><tr><th>商家</th><th>行业</th><th>客户登录电邮</th><th>状态</th><th class="right">操作</th></tr></thead><tbody>${table}</tbody></table></div>` : `<div class="empty">还没有商家</div>`}</section>`, { admin: true, active: "merchants" }));
}));

function merchantForm(merchant = {}) {
  const passwordRequired = merchant.id ? "" : "required";
  return `<div class="form-grid"><label>商家名称<input name="name" value="${escapeHtml(merchant.name)}" required></label><label>专属网址代号<input name="slug" value="${escapeHtml(merchant.slug)}" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required><small>只可使用小写英文、数字及连字符</small></label><label>商家行业<input name="industry" value="${escapeHtml(merchant.industry)}" required></label><label>评价语言<select name="language"><option value="zh" ${merchant.language === "zh" ? "selected" : ""}>中文</option><option value="en" ${merchant.language === "en" ? "selected" : ""}>English</option><option value="ms" ${merchant.language === "ms" ? "selected" : ""}>Bahasa Melayu</option></select></label><label class="full">官方 Google Review Link<input name="googleReviewLink" type="url" value="${escapeHtml(merchant.google_review_link)}" required></label><label>品牌颜色<input name="primaryColor" value="${escapeHtml(merchant.primary_color || "#2563EB")}" pattern="#[0-9A-Fa-f]{6}" required></label><label>商家 Logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG、JPG 或 WebP，最大 2MB</small></label><label>客户登录电邮<input name="clientEmail" type="email" value="${escapeHtml(merchant.client_email)}" autocomplete="off" required><small>每个商家使用独立登录电邮</small></label><label>客户电话号码<input name="clientPhone" type="tel" value="${escapeHtml(merchant.client_phone)}" maxlength="30" required><small>用于充值申请及联系客户</small></label><label>客户登录密码<input name="clientPassword" type="password" minlength="8" autocomplete="new-password" ${passwordRequired}><small>${merchant.id ? "留空代表保留现有密码" : "最少8个字符"}</small></label></div><div class="form-actions"><label class="check"><input name="active" type="checkbox" value="1" ${merchant.active === 0 ? "" : "checked"}> 已启用</label><button class="button primary" type="submit">保存商家及客户账号</button></div>`;
}

function merchantLoginSharePanel(req, merchant) {
  const loginUrl = `${publicBase()}${merchantPortalPath(merchant)}`;
  const shared = req.session.loginShare?.merchantId === merchant.id ? req.session.loginShare : null;
  if (shared) delete req.session.loginShare;
  const message = shared ? `您好，以下是 ${merchant.name} 的客户管理登录资料：\n登录网址：${loginUrl}\n登录电邮：${merchant.client_email}\n客户电话：${merchant.client_phone || "未填写"}\n登录密码：${shared.password}\n\n登录后可管理商家资料、评价资料库及下载客户报告。` : "";
  const sharedBox = shared ? `<div class="credentials-ready"><p><b>新密码已设置。登录资料只在本页显示一次，请立即复制或发送。</b></p><textarea id="loginCredentials" readonly>${escapeHtml(message)}</textarea><div class="share-actions"><button class="button" type="button" onclick="navigator.clipboard.writeText(document.getElementById('loginCredentials').value);this.textContent='已复制全部资料 ✓'">复制登录资料</button><a class="button whatsapp" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(message)}">使用 WhatsApp 发送</a></div></div>` : "";
  return `<section class="panel login-share-card"><p class="eyebrow">MERCHANT LOGIN</p><h2>商家登录及分享</h2><p>客户专属登录页面：</p><div class="copy-row"><input id="merchantLoginUrl" value="${escapeHtml(loginUrl)}" readonly><a class="button small ghost" target="_blank" href="${escapeHtml(loginUrl)}">打开</a><button class="button small" type="button" onclick="navigator.clipboard.writeText(document.getElementById('merchantLoginUrl').value);this.textContent='已复制 ✓'">复制 URL</button></div><div class="login-email"><span>客户登录电邮</span><b>${escapeHtml(merchant.client_email || "尚未设置")}</b></div>${sharedBox}<form class="share-password-form" method="post" action="/admin/merchants/${merchant.id}/share-login"><label>设置或重设客户密码<input name="password" type="password" minlength="8" autocomplete="new-password" required placeholder="最少8个字符"></label><button class="button primary" type="submit">重设并生成分享资料</button></form><small class="security-note">为保障客户安全，旧密码无法读取；每次分享密码时必须先重设。</small></section>`;
}

function topupDialog(merchant) {
  const options = Object.values(topupPackages).map((item) => `<button type="submit" name="amount" value="${item.amount}"><b>RM${item.amount}</b><span>${item.bonus ? `${item.amount} + ${item.bonus} 赠送分` : `${item.points} 分`}</span><strong>获得 ${item.points} 分</strong></button>`).join("");
  return `<dialog id="topupDialog" class="topup-dialog"><form method="dialog"><button class="dialog-close" aria-label="关闭">×</button></form><p class="eyebrow">TOP UP POINTS</p><h2>选择充值点数</h2><p>RM1 = 1分。选择后会记录申请，并打开 WhatsApp 联系平台管理员。</p><form method="post" action="${merchantPortalPath(merchant, "/billing/request")}"><label class="topup-phone">客户电话号码<input name="clientPhone" type="tel" maxlength="30" value="${escapeHtml(merchant.client_phone)}" required placeholder="例如：+6012-3456789"></label><div class="topup-package-grid">${options}</div></form><div class="topup-contact"><span>申请商家</span><b>${escapeHtml(merchant.name)}</b><span>${escapeHtml(merchant.client_email || "未填写电邮")}</span></div></dialog>`;
}

app.get("/admin/merchants/new", requireAdmin, (_req, res) => res.send(layout("新增商家", `<a class="back" href="/admin/merchants">← 返回所有商家</a><section class="panel form-panel"><p class="eyebrow">NEW MERCHANT</p><h1>新增商家</h1><p>建立商家后会自动加入评价模板并生成 QR Code。</p><form method="post" action="/admin/merchants" enctype="multipart/form-data">${merchantForm({ language: "zh", primary_color: "#2563EB", active: 1 })}</form></section>`, { admin: true, active: "merchants" })));

app.post("/admin/merchants", requireAdmin, upload.single("logo"), asyncRoute(async (req, res) => {
  const merchantId = id();
  const language = ["zh", "en", "ms"].includes(req.body.language) ? req.body.language : "zh";
  const clientEmail = String(req.body.clientEmail || "").trim().toLowerCase();
  const clientPhone = String(req.body.clientPhone || "").trim().slice(0, 30);
  const clientPassword = String(req.body.clientPassword || "");
  if (!clientEmail) return validationError(res, "请填写客户登录电邮。", "/admin/merchants/new");
  if (!clientPhone) return validationError(res, "请填写客户电话号码。", "/admin/merchants/new");
  if (clientPassword.length < 8) return validationError(res, "客户登录密码必须至少8个字符。", "/admin/merchants/new");
  const clientPasswordHash = hashPassword(clientPassword);
  await pool.query("INSERT INTO merchants (id,name,slug,industry,language,google_review_link,primary_color,client_email,client_phone,client_password_hash,logo_mime,logo_data,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [merchantId, req.body.name, req.body.slug, req.body.industry, language, req.body.googleReviewLink, req.body.primaryColor, clientEmail, clientPhone, clientPasswordHash, req.file?.mimetype || null, req.file?.buffer || null, req.body.active ? 1 : 0]);
  for (const templateLanguage of ["en", "zh", "ms"]) {
    for (const content of defaultTemplates[templateLanguage]) await pool.query("INSERT INTO review_templates (id,merchant_id,language,content) VALUES (?,?,?,?)", [id(), merchantId, templateLanguage, content]);
  }
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
  const templateRows = templates.map((t) => `<div class="template-row"><span class="language-badge">${languageName(t.language)}</span><p>${escapeHtml(t.content)}</p><form method="post" action="/admin/templates/${t.id}/delete"><input type="hidden" name="merchantId" value="${merchant.id}"><button class="icon-danger" type="submit" aria-label="删除评价">×</button></form></div>`).join("");
  res.send(layout(merchant.name, `<a class="back" href="/admin/merchants">← 返回所有商家</a>${req.query.created ? `<div class="notice success">商家已经建立。</div>` : ""}<header class="page-head"><div><p class="eyebrow">MERCHANT CONTROL</p><h1>${escapeHtml(merchant.name)}</h1><p>管理品牌资料、客户登录、评价内容和顾客入口。</p></div></header><div class="merchant-layout"><div><section class="panel form-panel"><h2>商家与客户账号</h2><form method="post" action="/admin/merchants/${merchant.id}" enctype="multipart/form-data">${merchantForm(merchant)}</form></section><section class="panel form-panel"><h2>评价资料库</h2><p>客户选择语言后，系统只会抽取相同语言的评价；首3条自定义评价免费，第4条开始每条一次性扣10分。</p><form class="template-add" method="post" action="/admin/templates"><input type="hidden" name="merchantId" value="${merchant.id}"><select name="language" aria-label="评价语言"><option value="en">English</option><option value="zh">中文</option><option value="ms">Bahasa Melayu</option></select><textarea name="content" maxlength="500" required placeholder="输入评价模板，可使用【商家名称】或【Business Name】。"></textarea><button class="button primary" type="submit">添加自定义评价</button></form>${templateRows}</section></div><aside>${merchantLoginSharePanel(req, merchant)}<section class="panel qr-card"><p class="eyebrow">MERCHANT QR</p><h2>专属 QR Code</h2><img src="${qr}" alt="${escapeHtml(merchant.name)} QR Code"><code>${publicBase()}/r/${escapeHtml(merchant.slug)}</code><a class="button primary" download="${escapeHtml(merchant.slug)}-qr.png" href="${qr}">下载 QR Code</a></section><section class="dark-card"><p class="eyebrow">LIVE DATA</p><h2>互动统计</h2><div><span><b>${statMap.scan || 0}</b><small>扫描</small></span><span><b>${statMap.generate || 0}</b><small>生成</small></span><span><b>${statMap.redirect || 0}</b><small>跳转</small></span></div></section></aside></div>`, { admin: true, active: "merchants" }));
}));

app.post("/admin/merchants/:id", requireAdmin, upload.single("logo"), asyncRoute(async (req, res) => {
  const clientEmail = String(req.body.clientEmail || "").trim().toLowerCase();
  const clientPhone = String(req.body.clientPhone || "").trim().slice(0, 30);
  const clientPassword = String(req.body.clientPassword || "");
  if (!clientEmail) return validationError(res, "请填写客户登录电邮。", `/admin/merchants/${req.params.id}/edit`);
  if (!clientPhone) return validationError(res, "请填写客户电话号码。", `/admin/merchants/${req.params.id}/edit`);
  if (clientPassword && clientPassword.length < 8) return validationError(res, "新客户密码必须至少8个字符。", `/admin/merchants/${req.params.id}/edit`);
  const params = [req.body.name, req.body.slug, req.body.industry, req.body.language, req.body.googleReviewLink, req.body.primaryColor, clientEmail, clientPhone, req.body.active ? 1 : 0];
  let sql = "UPDATE merchants SET name=?,slug=?,industry=?,language=?,google_review_link=?,primary_color=?,client_email=?,client_phone=?,active=?";
  if (clientPassword) { sql += ",client_password_hash=?"; params.push(hashPassword(clientPassword)); }
  if (req.file) { sql += ",logo_mime=?,logo_data=?"; params.push(req.file.mimetype, req.file.buffer); }
  sql += " WHERE id=?"; params.push(req.params.id);
  await pool.query(sql, params);
  res.redirect(`/admin/merchants/${req.params.id}/edit?saved=1`);
}));

app.post("/admin/merchants/:id/share-login", requireAdmin, asyncRoute(async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) return validationError(res, "客户登录密码必须至少8个字符。", `/admin/merchants/${req.params.id}/edit`);
  const [rows] = await pool.query("SELECT id,client_email FROM merchants WHERE id=? LIMIT 1", [req.params.id]);
  if (!rows[0]) return res.status(404).send("Merchant not found");
  if (!rows[0].client_email) return validationError(res, "请先保存客户登录电邮，再生成分享资料。", `/admin/merchants/${req.params.id}/edit`);
  await pool.query("UPDATE merchants SET client_password_hash=? WHERE id=?", [hashPassword(password), req.params.id]);
  req.session.loginShare = { merchantId: req.params.id, password };
  req.session.save(() => res.redirect(`/admin/merchants/${req.params.id}/edit?shared=1`));
}));

app.post("/admin/merchants/:id/delete", requireAdmin, asyncRoute(async (req, res) => { await pool.query("DELETE FROM merchants WHERE id=?", [req.params.id]); res.redirect("/admin/merchants"); }));
app.post("/admin/templates", requireAdmin, asyncRoute(async (req, res) => {
  try {
    await addCustomReviewTemplate(req.body.merchantId, req.body.language, req.body.content);
    res.redirect(`/admin/merchants/${req.body.merchantId}/edit`);
  } catch (error) {
    if (error.code === "LOW_BALANCE") return validationError(res, "商家余额只剩10分或以下，请先在点数收费页面充值。", `/admin/merchants/${req.body.merchantId}/edit`);
    throw error;
  }
}));
app.post("/admin/templates/:id/delete", requireAdmin, asyncRoute(async (req, res) => { await pool.query("DELETE FROM review_templates WHERE id=?", [req.params.id]); res.redirect(`/admin/merchants/${req.body.merchantId}/edit`); }));

app.get("/admin/reviews", requireAdmin, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query("SELECT m.id,m.name,COUNT(t.id) total,SUM(t.language='en') en_total,SUM(t.language='zh') zh_total,SUM(t.language='ms') ms_total FROM merchants m LEFT JOIN review_templates t ON t.merchant_id=m.id GROUP BY m.id ORDER BY m.created_at DESC");
  res.send(layout("评价资料", `<header class="page-head"><div><p class="eyebrow">REVIEW LIBRARY</p><h1>评价资料</h1><p>管理每个商家的英文、中文及马来文评价。</p></div></header><section class="card-list">${rows.map((m) => `<article><div><h2>${escapeHtml(m.name)}</h2><p class="language-counts"><span>English ${Number(m.en_total) || 0}</span><span>中文 ${Number(m.zh_total) || 0}</span><span>Bahasa Melayu ${Number(m.ms_total) || 0}</span></p></div><a class="button" href="/admin/merchants/${m.id}/edit">管理评价</a></article>`).join("") || `<div class="empty">还没有商家</div>`}</section>`, { admin: true, active: "reviews" }));
}));

app.get("/admin/reports", requireAdmin, asyncRoute(async (req, res) => {
  const [merchants] = await pool.query("SELECT id,name FROM merchants ORDER BY name");
  const selectedMerchant = merchants.find((merchant) => merchant.id === req.query.merchantId) || merchants[0];
  const month = validMonth(req.query.month);
  if (!selectedMerchant) return res.send(layout("客户报告", `<header class="page-head"><div><p class="eyebrow">CUSTOMER REPORT</p><h1>客户报告</h1><p>建立商家后即可查看使用记录。</p></div></header><div class="empty">还没有商家</div>`, { admin: true, active: "reports" }));
  const [start, end] = monthBounds(month);
  const [[summaryRows], [records], [balanceRows]] = await Promise.all([
    pool.query(`SELECT COUNT(CASE WHEN event_type='visit' THEN 1 END) visits,
      COUNT(DISTINCT CASE WHEN event_type='visit' THEN visitor_hash END) unique_visitors,
      COUNT(CASE WHEN event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN event_type='review_added' THEN 1 END) added,
      COALESCE(-SUM(CASE WHEN points_delta<0 THEN points_delta ELSE 0 END),0) points_used
      FROM usage_ledger WHERE merchant_id=? AND created_at>=? AND created_at<?`, [selectedMerchant.id, start, end]),
    pool.query("SELECT event_type,language,review_text,points_delta,note,created_at FROM usage_ledger WHERE merchant_id=? AND event_type<>'visit' AND created_at>=? AND created_at<? ORDER BY created_at DESC", [selectedMerchant.id, start, end]),
    pool.query("SELECT COALESCE(SUM(points_delta),0) balance FROM usage_ledger WHERE merchant_id=?", [selectedMerchant.id]),
  ]);
  const summary = summaryRows[0] || {};
  const filters = `<form class="report-filters" method="get"><label>选择商家<select name="merchantId">${merchants.map((merchant) => `<option value="${merchant.id}" ${merchant.id === selectedMerchant.id ? "selected" : ""}>${escapeHtml(merchant.name)}</option>`).join("")}</select></label><label>选择月份<input type="month" name="month" value="${month}" required></label><button class="button primary" type="submit">查看报告</button><a class="button" href="/admin/reports.csv?merchantId=${selectedMerchant.id}&month=${month}">下载 CSV</a></form>`;
  const cards = [["进入次数", Number(summary.visits) || 0, "只统计，不扣点数"], ["独立访客", Number(summary.unique_visitors) || 0, "按装置匿名统计"], ["使用评价", Number(summary.generated) || 0, "每次生成扣 1 分"], ["本月使用", `${Number(summary.points_used) || 0} 分`, `余额 ${Number(balanceRows[0]?.balance) || 0} 分`]];
  const rows = records.map((record) => `<tr><td>${formatDateTime(record.created_at)}</td><td>${usageLabel(record.event_type)}</td><td>${record.language ? languageName(record.language) : "—"}</td><td class="review-copy">${escapeHtml(record.review_text || record.note || "—")}</td><td class="points ${Number(record.points_delta) < 0 ? "negative" : Number(record.points_delta) > 0 ? "positive" : ""}">${Number(record.points_delta) > 0 ? "+" : ""}${Number(record.points_delta)} 分</td></tr>`).join("");
  res.send(layout("客户报告", `<header class="page-head"><div><p class="eyebrow">CUSTOMER REPORT</p><h1>客户报告</h1><p>查看每个商家的访问人数、使用评价及点数记录。</p></div></header><section class="panel report-panel">${filters}</section><section class="stats report-stats">${cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}</section><section class="panel"><div class="panel-head"><h2>${escapeHtml(selectedMerchant.name)} · ${month}</h2><p>此月份的全部客户使用及收费记录</p></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>记录</th><th>语言</th><th>使用的评价／说明</th><th>点数</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">此月份还没有记录</div>`}</section>`, { admin: true, active: "reports" }));
}));

app.get("/admin/reports.csv", requireAdmin, asyncRoute(async (req, res) => {
  const month = validMonth(req.query.month);
  const [start, end] = monthBounds(month);
  const [[merchants], [records]] = await Promise.all([
    pool.query("SELECT id,name,slug FROM merchants WHERE id=? LIMIT 1", [req.query.merchantId]),
    pool.query("SELECT event_type,language,review_text,points_delta,note,created_at FROM usage_ledger WHERE merchant_id=? AND event_type<>'visit' AND created_at>=? AND created_at<? ORDER BY created_at", [req.query.merchantId, start, end]),
  ]);
  const merchant = merchants[0];
  if (!merchant) return res.status(404).send("Merchant not found");
  const header = ["Date & Time", "Type", "Language", "Review / Note", "Points"];
  const csv = [header, ...records.map((record) => [formatDateTime(record.created_at), usageLabel(record.event_type), record.language ? languageName(record.language) : "", record.review_text || record.note || "", Number(record.points_delta)])].map((row) => row.map(csvCell).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${merchant.slug}-${month}-report.csv"`);
  res.send(`\uFEFF${csv}`);
}));

function topupSuccessButton(transaction) {
  if (transaction.event_type !== "topup") return "—";
  const phone = whatsappNumber(transaction.client_phone);
  if (!phone) return `<span class="status">缺少电话</span>`;
  const fee = String(transaction.note || "").match(/RM[\d,]+/)?.[0] || "未注明";
  const message = `您好 ${transaction.name}，您的 Google Review Assistant 点数已经充值成功。\n\n客户电邮：${transaction.client_email || "未填写"}\n充值费用：${fee}\n充值点数：${Number(transaction.points_delta)}分\n充值时间：${formatDateTime(transaction.created_at)}\n目前点数余额：${Number(transaction.current_balance)}分\n\n请返回客户评价资料库刷新页面：\n${publicBase()}/client/${encodeURIComponent(transaction.slug)}/reviews\n\n谢谢。`;
  return `<a class="button small whatsapp" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${encodeURIComponent(message)}">WhatsApp通知</a>`;
}

app.get("/admin/billing", requireAdmin, asyncRoute(async (req, res) => {
  const [[merchants], [transactions]] = await Promise.all([
    pool.query(`SELECT m.id,m.name,m.slug,COALESCE(SUM(u.points_delta),0) balance,
      COUNT(CASE WHEN u.event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN u.event_type='review_added' THEN 1 END) reviews_added,
      COALESCE(-SUM(CASE WHEN u.points_delta<0 THEN u.points_delta ELSE 0 END),0) points_used
      FROM merchants m LEFT JOIN usage_ledger u ON u.merchant_id=m.id GROUP BY m.id ORDER BY m.name`),
    pool.query(`SELECT u.event_type,u.points_delta,u.note,u.created_at,m.name,m.slug,m.client_email,m.client_phone,
      (SELECT COALESCE(SUM(balance_entry.points_delta),0) FROM usage_ledger balance_entry WHERE balance_entry.merchant_id=u.merchant_id) current_balance
      FROM usage_ledger u JOIN merchants m ON m.id=u.merchant_id
      WHERE u.event_type IN ('topup','topup_request','review_generated','review_added') ORDER BY u.created_at DESC LIMIT 50`),
  ]);
  const merchantCards = merchants.map((merchant) => `<article class="billing-card"><div class="billing-head"><div><p class="eyebrow">${escapeHtml(merchant.slug)}</p><h2>${escapeHtml(merchant.name)}</h2></div><strong class="balance ${Number(merchant.balance) < 0 ? "low" : ""}">${Number(merchant.balance)}<small>分</small></strong></div><div class="usage-split"><span><b>${Number(merchant.generated)}</b><small>生成评价 × 1分</small></span><span><b>${Number(merchant.reviews_added)}</b><small>新增评价 × 10分</small></span><span><b>${Number(merchant.points_used)}</b><small>累计使用分数</small></span></div><p class="topup-title">人工充值 · RM1 = 1分</p><div class="topup-options">${Object.values(topupPackages).map((item) => `<form method="post" action="/admin/billing/topup" onsubmit="return confirm('确认已收款 RM${item.amount}，并充值 ${item.points} 分？')"><input type="hidden" name="merchantId" value="${merchant.id}"><input type="hidden" name="amount" value="${item.amount}"><button type="submit">RM${item.amount}<small>+${item.points}分</small></button></form>`).join("")}</div><a class="report-link" href="/admin/reports?merchantId=${merchant.id}">查看客户报告 →</a></article>`).join("");
  const transactionRows = transactions.map((transaction) => `<tr><td>${formatDateTime(transaction.created_at)}</td><td>${escapeHtml(transaction.name)}</td><td>${usageLabel(transaction.event_type)}</td><td>${escapeHtml(transaction.note || "—")}</td><td class="points ${Number(transaction.points_delta) < 0 ? "negative" : Number(transaction.points_delta) > 0 ? "positive" : ""}">${Number(transaction.points_delta) > 0 ? "+" : ""}${Number(transaction.points_delta)} 分</td><td>${topupSuccessButton(transaction)}</td></tr>`).join("");
  res.send(layout("点数收费", `<header class="page-head"><div><p class="eyebrow">USAGE & BILLING</p><h1>点数收费</h1><p>RM1 等于 1 分；客户每次生成评价扣 1 分，新增每条评价一次性扣 10 分。</p></div></header>${req.query.toppedUp ? `<div class="notice success">充值完成，已加入 ${Number(req.query.toppedUp)} 分。</div>` : ""}<section class="billing-grid">${merchantCards || `<div class="empty">还没有商家</div>`}</section><section class="panel"><div class="panel-head"><h2>最近点数记录</h2><p>显示最近 50 条充值与扣分记录；进入评价页只作后台统计</p></div>${transactionRows ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>商家</th><th>项目</th><th>说明</th><th>点数</th><th>通知商家</th></tr></thead><tbody>${transactionRows}</tbody></table></div>` : `<div class="empty">还没有点数记录</div>`}</section>`, { admin: true, active: "billing" }));
}));

app.post("/admin/billing/topup", requireAdmin, asyncRoute(async (req, res) => {
  const selectedPackage = topupPackages[String(req.body.amount || "")];
  if (!selectedPackage) return res.status(400).send("Invalid top-up package");
  const bonusText = selectedPackage.bonus ? `（含赠送 ${selectedPackage.bonus} 分）` : "";
  await pool.query("INSERT INTO usage_ledger (id,merchant_id,event_type,points_delta,note) VALUES (?,?,?,?,?)", [id(), req.body.merchantId, "topup", selectedPackage.points, `后台确认充值 RM${selectedPackage.amount}${bonusText}`]);
  res.redirect(`/admin/billing?toppedUp=${selectedPackage.points}`);
}));

app.get("/client", asyncRoute(async (req, res) => {
  const logins = clientLogins(req);
  const preferredSlug = req.session.lastClientSlug;
  if (preferredSlug && logins[preferredSlug]) {
    const [rows] = await pool.query("SELECT id,slug FROM merchants WHERE id=? AND slug=? AND active=1 LIMIT 1", [logins[preferredSlug], preferredSlug]);
    if (rows[0]) return res.redirect(merchantPortalPath(rows[0]));
  }
  const firstLogin = Object.entries(logins)[0];
  if (firstLogin) {
    const [rows] = await pool.query("SELECT id,slug FROM merchants WHERE id=? AND slug=? AND active=1 LIMIT 1", [firstLogin[1], firstLogin[0]]);
    if (rows[0]) return res.redirect(merchantPortalPath(rows[0]));
  }
  res.status(403).send(layout("请使用商家专属后台", `<main class="login-page"><section class="login-card"><span class="brand-mark large">R</span><p class="eyebrow">MERCHANT PORTAL</p><h1>请使用商家专属后台</h1><p>每个商家都有不同的后台网址。请使用平台管理员发送给您的专属连接登录。</p><small>例如：${escapeHtml(publicBase())}/client/client-name</small></section></main>`));
}));

app.get("/client/:slug", asyncRoute(async (req, res) => {
  const [merchantRows] = await pool.query("SELECT * FROM merchants WHERE slug=? AND active=1 LIMIT 1", [req.params.slug]);
  const merchant = merchantRows[0];
  if (!merchant) return res.status(404).send(layout("找不到商家后台", `<main class="login-page"><section class="login-card"><h1>找不到商家后台</h1><p>请向平台管理员索取正确的专属网址。</p></section></main>`));
  if (!isClientLoggedIn(req, merchant)) return res.send(clientLoginMarkup(req, merchant));
  if (req.session.clientMerchantId === merchant.id) rememberClientLogin(req, merchant);
  req.clientMerchant = merchant;
  const clientBase = merchantPortalPath(merchant);
  const reviewUrl = `${publicBase()}/r/${merchant.slug}`;
  const qr = await QRCode.toDataURL(reviewUrl, { width: 360, margin: 2 });
  const [[summaryRows], [recentRows]] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(points_delta),0) balance,
      COUNT(CASE WHEN event_type='visit' THEN 1 END) visits,
      COUNT(CASE WHEN event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN event_type='review_added' THEN 1 END) reviews_added
      FROM usage_ledger WHERE merchant_id=?`, [merchant.id]),
    pool.query("SELECT event_type,points_delta,note,created_at FROM usage_ledger WHERE merchant_id=? AND event_type<>'visit' ORDER BY created_at DESC LIMIT 8", [merchant.id]),
  ]);
  const summary = summaryRows[0] || {};
  const freeRemaining = Math.max(0, 3 - Number(summary.reviews_added || 0));
  const cards = [["点数余额", `${Number(summary.balance) || 0} 分`, "充值请联系平台管理员"], ["客户进入", Number(summary.visits) || 0, "只统计，不扣点数"], ["使用评价", Number(summary.generated) || 0, "每次生成扣1分"], ["免费评价", `${freeRemaining} 条`, "第4条起每条扣10分"]];
  const recent = recentRows.map((row) => `<tr><td>${formatDateTime(row.created_at)}</td><td>${usageLabel(row.event_type)}</td><td>${escapeHtml(row.note || "—")}</td><td class="points ${Number(row.points_delta) < 0 ? "negative" : Number(row.points_delta) > 0 ? "positive" : ""}">${Number(row.points_delta) > 0 ? "+" : ""}${Number(row.points_delta)} 分</td></tr>`).join("");
  res.send(layout("客户主页", `<header class="page-head"><div><p class="eyebrow">MERCHANT DASHBOARD</p><h1>${escapeHtml(merchant.name)}</h1><p>管理您的商家资料、评价内容及客户报告。</p></div><a class="button primary" target="_blank" href="/r/${encodeURIComponent(merchant.slug)}">打开客户评价页</a></header><section class="stats">${cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}</section><section class="quick-grid"><a href="${clientBase}/merchant"><b>商家资料</b><span>更新行业、Google Review Link、品牌颜色及Logo →</span></a><a href="${clientBase}/reviews"><b>评价资料库</b><span>管理英文、中文及马来文评价 →</span></a><a href="${clientBase}/reports"><b>客户报告</b><span>按月份浏览及下载CSV →</span></a></section><section class="panel dashboard-qr"><div><p class="eyebrow">专属 QR CODE</p><h2>${escapeHtml(merchant.name)} 专属 QR Code</h2><p>顾客扫描后会直接进入您的评价生成页面。</p><code>${escapeHtml(reviewUrl)}</code><div class="form-actions"><a class="button primary" target="_blank" href="/r/${encodeURIComponent(merchant.slug)}">打开评价页</a><a class="button" download="${escapeHtml(merchant.slug)}-qr.png" href="${qr}">下载 QR Code</a></div></div><div class="qr-card"><img src="${qr}" alt="${escapeHtml(merchant.name)} 专属 QR Code"></div></section><section class="panel"><div class="panel-head"><h2>最近记录</h2><p>您账号最近的使用和点数变化</p></div>${recent ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>项目</th><th>说明</th><th>点数</th></tr></thead><tbody>${recent}</tbody></table></div>` : `<div class="empty">还没有使用记录</div>`}</section>`, { client: merchant, active: "dashboard" }));
}));

app.get("/client/:slug/merchant", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const clientBase = merchantPortalPath(merchant);
  const notice = req.query.saved ? `<div class="notice success">商家资料已经更新。</div>` : req.query.phoneRequired ? `<div class="notice error">请先填写客户电话号码，才能发送充值申请。</div>` : "";
  res.send(layout("商家资料", `<header class="page-head"><div><p class="eyebrow">MERCHANT PROFILE</p><h1>商家资料</h1><p>商家名称和专属网址代号由平台管理，不可自行更改。</p></div></header>${notice}<section class="panel form-panel"><form method="post" action="${clientBase}/merchant" enctype="multipart/form-data"><div class="form-grid"><label>商家名称<input value="${escapeHtml(merchant.name)}" readonly><small>如需修改，请联系平台管理员</small></label><label>专属网址代号<input value="${escapeHtml(merchant.slug)}" readonly><small>此代号已锁定</small></label><label>商家行业<input name="industry" value="${escapeHtml(merchant.industry)}" required></label><label>客户登录电邮<input value="${escapeHtml(merchant.client_email)}" readonly><small>登录资料由平台管理员控制</small></label><label>客户电话号码<input name="clientPhone" type="tel" maxlength="30" value="${escapeHtml(merchant.client_phone)}" required><small>用于充值申请及平台联系</small></label><label class="full">官方 Google Review Link<input name="googleReviewLink" type="url" value="${escapeHtml(merchant.google_review_link)}" required></label><label>品牌颜色<input name="primaryColor" value="${escapeHtml(merchant.primary_color)}" pattern="#[0-9A-Fa-f]{6}" required></label><label>商家 Logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG、JPG 或 WebP，最大2MB</small></label></div><div class="form-actions"><span class="locked-note">🔒 名称及网址代号已锁定</span><button class="button primary" type="submit">保存商家资料</button></div></form></section>`, { client: merchant, active: "merchant" }));
}));

app.post("/client/:slug/merchant", requireClient, upload.single("logo"), asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const clientBase = merchantPortalPath(merchant);
  const clientPhone = String(req.body.clientPhone || "").trim().slice(0, 30);
  if (!clientPhone) return validationError(res, "请填写客户电话号码。", `${clientBase}/merchant`);
  const params = [String(req.body.industry || "").trim(), clientPhone, req.body.googleReviewLink, req.body.primaryColor];
  let sql = "UPDATE merchants SET industry=?,client_phone=?,google_review_link=?,primary_color=?";
  if (req.file) { sql += ",logo_mime=?,logo_data=?"; params.push(req.file.mimetype, req.file.buffer); }
  sql += " WHERE id=?";
  params.push(merchant.id);
  await pool.query(sql, params);
  res.redirect(`${clientBase}/merchant?saved=1`);
}));

app.get("/client/:slug/reviews", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const clientBase = merchantPortalPath(merchant);
  const [[templates], [countRows], [balanceRows]] = await Promise.all([
    pool.query("SELECT * FROM review_templates WHERE merchant_id=? ORDER BY language,created_at DESC", [merchant.id]),
    pool.query("SELECT COUNT(*) total FROM usage_ledger WHERE merchant_id=? AND event_type='review_added'", [merchant.id]),
    pool.query("SELECT COALESCE(SUM(points_delta),0) balance FROM usage_ledger WHERE merchant_id=?", [merchant.id]),
  ]);
  const additionCount = Number(countRows[0]?.total || 0);
  const nextNumber = additionCount + 1;
  const nextCharge = nextNumber <= 3 ? "免费" : "扣10分";
  const balance = Number(balanceRows[0]?.balance || 0);
  const lowBalance = balance <= 10;
  const templateRows = templates.map((template) => `<div class="template-row"><span class="language-badge">${languageName(template.language)}</span><p>${escapeHtml(template.content)}</p><form method="post" action="${clientBase}/reviews/${template.id}/delete" onsubmit="return confirm('确定删除这条评价？已扣除的点数不会退回。')"><button class="icon-danger" type="submit" aria-label="删除评价">×</button></form></div>`).join("");
  const created = req.query.added ? `<div class="notice success">第 ${Number(req.query.added)} 条自定义评价已添加，${Number(req.query.points) === 0 ? "本次免费" : "已扣10分"}。</div>` : "";
  res.send(layout("评价资料库", `<header class="page-head"><div><p class="eyebrow">REVIEW LIBRARY</p><h1>评价资料库</h1><p>自定义评价首3条免费，第4条开始每新增一条一次性扣10分。</p></div><strong class="balance ${lowBalance ? "low" : ""}">${balance}<small>余额／分</small></strong></header>${created}${lowBalance ? `<section class="balance-warning"><div><b>余额只剩 ${balance} 分，现已暂停新增评价。</b><span>请先提交充值申请；平台管理员确认后会为您的账户添加点数。</span></div><button class="button primary" type="button" onclick="document.getElementById(&quot;topupDialog&quot;).showModal()">选择充值点数</button></section>${topupDialog(merchant)}<section class="panel form-panel locked-review-form"><h2>新增评价已暂停</h2><p>余额必须高于10分才可继续添加评价，包括首3条免费评价。</p><button class="button" type="button" onclick="document.getElementById(&quot;topupDialog&quot;).showModal()">充值后继续</button></section>` : `<section class="panel form-panel"><h2>添加第 ${nextNumber} 条自定义评价 · ${nextCharge}</h2><form class="template-add" method="post" action="${clientBase}/reviews"><select name="language" aria-label="评价语言"><option value="en">English</option><option value="zh">中文</option><option value="ms">Bahasa Melayu</option></select><textarea name="content" maxlength="500" required placeholder="输入评价，可使用【商家名称】或【Business Name】。"></textarea><button class="button primary" type="submit">添加评价 · ${nextCharge}</button></form></section>`}<section class="panel form-panel"><h2>现有评价</h2><p>系统提供的三语基础评价不会占用首3条免费额度。</p>${templateRows || `<div class="empty">还没有评价</div>`}</section>`, { client: merchant, active: "reviews" }));
}));

app.post("/client/:slug/reviews", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const clientBase = merchantPortalPath(merchant);
  try {
    const result = await addCustomReviewTemplate(merchant.id, req.body.language, req.body.content);
    res.redirect(`${clientBase}/reviews?added=${result.additionNumber}&points=${result.points}`);
  } catch (error) {
    if (error.code === "LOW_BALANCE") return res.redirect(`${clientBase}/reviews?lowBalance=1`);
    throw error;
  }
}));

app.post("/client/:slug/billing/request", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const reviewsPath = merchantPortalPath(merchant, "/reviews");
  const selectedPackage = topupPackages[String(req.body.amount || "")];
  if (!selectedPackage) return res.status(400).send("Invalid top-up package");
  if (!adminWhatsapp()) return validationError(res, "平台充值WhatsApp尚未设置，请联系管理员。", reviewsPath);
  const clientPhone = String(req.body.clientPhone || "").trim().slice(0, 30);
  if (!clientPhone) return validationError(res, "请填写客户电话号码。", reviewsPath);
  await pool.query("UPDATE merchants SET client_phone=? WHERE id=?", [clientPhone, merchant.id]);
  const packageText = selectedPackage.bonus ? `RM${selectedPackage.amount} + ${selectedPackage.bonus}赠送分` : `RM${selectedPackage.amount}`;
  const message = `您好 Ryan，我想申请充值 Google Review Assistant 点数。\n\n商家名称：${merchant.name}\n客户电邮：${merchant.client_email || "未填写"}\n客户电话：${clientPhone}\n选择配套：${packageText}\n获得点数：${selectedPackage.points}分\n目前状态：等待平台管理员确认及回复。`;
  await pool.query("INSERT INTO usage_ledger (id,merchant_id,event_type,points_delta,note) VALUES (?,?,?,?,?)", [id(), merchant.id, "topup_request", 0, `充值申请 ${packageText}，获得${selectedPackage.points}分；电话 ${clientPhone}`]);
  res.redirect(`https://wa.me/${adminWhatsapp()}?text=${encodeURIComponent(message)}`);
}));

app.post("/client/:slug/reviews/:id/delete", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  await pool.query("DELETE FROM review_templates WHERE id=? AND merchant_id=?", [req.params.id, merchant.id]);
  res.redirect(merchantPortalPath(merchant, "/reviews"));
}));

app.get("/client/:slug/reports", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const clientBase = merchantPortalPath(merchant);
  const month = validMonth(req.query.month);
  const [start, end] = monthBounds(month);
  const [[summaryRows], [records], [balanceRows]] = await Promise.all([
    pool.query(`SELECT COUNT(CASE WHEN event_type='visit' THEN 1 END) visits,
      COUNT(DISTINCT CASE WHEN event_type='visit' THEN visitor_hash END) unique_visitors,
      COUNT(CASE WHEN event_type='review_generated' THEN 1 END) generated,
      COUNT(CASE WHEN event_type='review_added' THEN 1 END) added,
      COALESCE(-SUM(CASE WHEN points_delta<0 THEN points_delta ELSE 0 END),0) points_used
      FROM usage_ledger WHERE merchant_id=? AND created_at>=? AND created_at<?`, [merchant.id, start, end]),
    pool.query("SELECT event_type,language,review_text,points_delta,note,created_at FROM usage_ledger WHERE merchant_id=? AND event_type<>'visit' AND created_at>=? AND created_at<? ORDER BY created_at DESC", [merchant.id, start, end]),
    pool.query("SELECT COALESCE(SUM(points_delta),0) balance FROM usage_ledger WHERE merchant_id=?", [merchant.id]),
  ]);
  const summary = summaryRows[0] || {};
  const filters = `<form class="report-filters client-report-filter" method="get" action="${clientBase}/reports"><label>选择月份<input type="month" name="month" value="${month}" required></label><button class="button primary" type="submit">查看报告</button><a class="button" href="${clientBase}/reports.csv?month=${month}">下载 CSV</a></form>`;
  const cards = [["进入次数", Number(summary.visits) || 0, "只统计，不扣点数"], ["独立访客", Number(summary.unique_visitors) || 0, "匿名装置统计"], ["使用评价", Number(summary.generated) || 0, "每次生成扣1分"], ["本月使用", `${Number(summary.points_used) || 0} 分`, `余额 ${Number(balanceRows[0]?.balance) || 0} 分`]];
  const rows = records.map((record) => `<tr><td>${formatDateTime(record.created_at)}</td><td>${usageLabel(record.event_type)}</td><td>${record.language ? languageName(record.language) : "—"}</td><td class="review-copy">${escapeHtml(record.review_text || record.note || "—")}</td><td class="points ${Number(record.points_delta) < 0 ? "negative" : Number(record.points_delta) > 0 ? "positive" : ""}">${Number(record.points_delta) > 0 ? "+" : ""}${Number(record.points_delta)} 分</td></tr>`).join("");
  res.send(layout("客户报告", `<header class="page-head"><div><p class="eyebrow">CUSTOMER REPORT</p><h1>客户报告</h1><p>浏览及下载 ${escapeHtml(merchant.name)} 的月份报告。</p></div></header><section class="panel report-panel">${filters}</section><section class="stats report-stats">${cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}</section><section class="panel"><div class="panel-head"><h2>${month} 使用记录</h2><p>客户访问、使用评价及点数记录</p></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>记录</th><th>语言</th><th>使用的评价／说明</th><th>点数</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">此月份还没有记录</div>`}</section>`, { client: merchant, active: "reports" }));
}));

app.get("/client/:slug/reports.csv", requireClient, asyncRoute(async (req, res) => {
  const merchant = await getClientMerchant(req);
  if (!merchant) return clearClientLogin(req, res);
  const month = validMonth(req.query.month);
  const [start, end] = monthBounds(month);
  const [records] = await pool.query("SELECT event_type,language,review_text,points_delta,note,created_at FROM usage_ledger WHERE merchant_id=? AND event_type<>'visit' AND created_at>=? AND created_at<? ORDER BY created_at", [merchant.id, start, end]);
  const header = ["Date & Time", "Type", "Language", "Review / Note", "Points"];
  const csv = [header, ...records.map((record) => [formatDateTime(record.created_at), usageLabel(record.event_type), record.language ? languageName(record.language) : "", record.review_text || record.note || "", Number(record.points_delta)])].map((row) => row.map(csvCell).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${merchant.slug}-${month}-report.csv"`);
  res.send(`\uFEFF${csv}`);
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
  const selectedLanguage = ["en", "zh", "ms"].includes(req.query.lang) ? req.query.lang : "en";
  const [templates] = await pool.query("SELECT content FROM review_templates WHERE merchant_id=? AND language=? AND active=1", [merchant.id, selectedLanguage]);
  if (!req.query.lang) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("INSERT INTO events (id,merchant_id,type) VALUES (?,?, 'scan')", [id(), merchant.id]);
      await connection.query("INSERT INTO usage_ledger (id,merchant_id,event_type,language,points_delta,visitor_hash,note) VALUES (?,?,?,?,?,?,?)", [id(), merchant.id, "visit", selectedLanguage, 0, visitorHash(req), "客户进入评价页面（仅统计）"]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  const texts = templates.map((t) => t.content.replaceAll("【商家名称】", merchant.name).replaceAll("【Business Name】", merchant.name));
  const copies = {
    en: { thanks: "Thank you for your support!", intro: "Follow these steps to leave your Google review.", stepsTitle: "How to submit your review", steps: ["Choose your preferred language above.", "Tap “Generate review and go to Google”. The review draft will be copied and Google Reviews will open.", "Choose a star rating based on your genuine experience. Tap the review box, then press and hold to paste the text.", "Edit the draft so it reflects your own experience, then tap Post."], button: "Generate review and go to Google", copied: "Review copied ✓", hint: "On Google Reviews, press and hold to paste your review.", policy: "The generated text is for reference only. Please edit it based on your genuine experience and choose an appropriate rating.", fallback: "Your browser could not copy automatically. Press and hold the review below to copy it.", go: "Go to Google Review" },
    zh: { thanks: "感谢您的支持！", intro: "请按照以下步骤提交您的 Google 评价。", stepsTitle: "如何提交评价", steps: ["在页面上方选择您想使用的语言。", "点击“生成评价并前往 Google”，评价草稿会自动复制，并打开 Google Review。", "根据您的真实体验选择星级；点击评价输入框，然后长按并选择“粘贴”。", "按您的实际体验修改评价内容，确认后点击“发布”。"], button: "生成评价并前往 Google", copied: "评价已复制 ✓", hint: "前往 Google Review 后，请长按并粘贴评价。", policy: "系统生成的文字仅供参考，请根据您的真实体验进行修改，并自行选择适合的评分。", fallback: "您的浏览器无法自动复制，请长按下面的评价并选择复制。", go: "前往 Google Review" },
    ms: { thanks: "Terima kasih atas sokongan anda!", intro: "Ikuti langkah berikut untuk menghantar ulasan Google anda.", stepsTitle: "Cara menghantar ulasan", steps: ["Pilih bahasa pilihan anda di bahagian atas.", "Tekan “Jana ulasan dan pergi ke Google”. Draf ulasan akan disalin dan Google Reviews akan dibuka.", "Pilih penilaian bintang berdasarkan pengalaman sebenar anda. Tekan ruang ulasan, kemudian tekan lama dan pilih “Tampal”.", "Ubah draf supaya mencerminkan pengalaman anda sendiri, kemudian tekan “Siarkan”."], button: "Jana ulasan dan pergi ke Google", copied: "Ulasan telah disalin ✓", hint: "Di Google Reviews, tekan lama untuk menampal ulasan.", policy: "Teks ini hanya sebagai rujukan. Sila ubah berdasarkan pengalaman sebenar dan pilih penilaian yang sesuai.", fallback: "Pelayar anda tidak dapat menyalin secara automatik. Tekan lama teks di bawah untuk menyalinnya.", go: "Pergi ke Google Review" },
  };
  const copy = copies[selectedLanguage];
  const languageSwitch = `<nav class="language-switch" aria-label="Select language"><a href="?lang=en" class="${selectedLanguage === "en" ? "active" : ""}" lang="en">English</a><a href="?lang=zh" class="${selectedLanguage === "zh" ? "active" : ""}" lang="zh-Hans">中文</a><a href="?lang=ms" class="${selectedLanguage === "ms" ? "active" : ""}" lang="ms">Bahasa Melayu</a></nav>`;
  const documentLanguage = selectedLanguage === "zh" ? "zh-Hans" : selectedLanguage;
  const instructions = `<section class="review-steps" aria-labelledby="reviewStepsTitle"><h3 id="reviewStepsTitle">${escapeHtml(copy.stepsTitle)}</h3><ol>${copy.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section>`;
  res.send(layout(merchant.name, `<main class="public-page"><section class="review-card" style="--brand:${escapeHtml(merchant.primary_color)}">${languageSwitch}${merchant.logo_data ? `<img class="merchant-logo" src="/media/${merchant.id}" alt="${escapeHtml(merchant.name)} Logo">` : `<div class="merchant-logo placeholder">R</div>`}<p class="eyebrow">GOOGLE REVIEW ASSISTANT</p><h1>${escapeHtml(merchant.name)}</h1><h2>${copy.thanks}</h2><p>${copy.intro}</p>${instructions}<button id="generate" class="review-button">${copy.button}<span>→</span></button><p id="hint" class="hint" hidden>${copy.hint}</p><div id="fallback" class="fallback" hidden><p>${copy.fallback}</p><blockquote id="reviewText"></blockquote><a href="${escapeHtml(merchant.google_review_link)}">${copy.go}</a></div><p class="policy">${copy.policy}</p></section><footer>Powered by <a href="https://ryankey.com.my/">RyanKey Designs</a></footer></main><script>const templates=${JSON.stringify(texts).replace(/</g, "\\u003c")};const merchantId=${JSON.stringify(merchant.id)};const selectedLanguage=${JSON.stringify(selectedLanguage)};const reviewLink=${JSON.stringify(merchant.google_review_link)};const button=document.getElementById('generate');const hint=document.getElementById('hint');const fallback=document.getElementById('fallback');const reviewText=document.getElementById('reviewText');async function event(type,text=''){try{await fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchantId,type,language:selectedLanguage,reviewText:text})})}catch{}}button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;const text=templates[Math.floor(Math.random()*templates.length)]||${JSON.stringify(copy.policy)};event('generate',text);try{await navigator.clipboard.writeText(text);button.textContent=${JSON.stringify(copy.copied)};hint.hidden=false;setTimeout(()=>{event('redirect');location.href=reviewLink},1300)}catch{reviewText.textContent=text;fallback.hidden=false;button.disabled=false;}});</script>`, { lang: documentLanguage }));
}));

app.post("/api/events", asyncRoute(async (req, res) => {
  if (!["generate", "redirect"].includes(req.body.type) || !req.body.merchantId) return res.status(400).json({ ok: false });
  const language = ["en", "zh", "ms"].includes(req.body.language) ? req.body.language : null;
  const reviewText = String(req.body.reviewText || "").slice(0, 500);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("INSERT INTO events (id,merchant_id,type) VALUES (?,?,?)", [id(), req.body.merchantId, req.body.type]);
    if (req.body.type === "generate") await connection.query("INSERT INTO usage_ledger (id,merchant_id,event_type,language,review_text,points_delta,note) VALUES (?,?,?,?,?,-1,?)", [id(), req.body.merchantId, "review_generated", language, reviewText, "客户生成评价（扣1分）"]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.json({ ok: true });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  const message = error?.code === "ER_DUP_ENTRY" ? "网址代号或客户登录电邮已经使用，请更换后再试。" : "系统暂时无法完成操作，请稍后重试。";
  res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).send(layout("系统提示", `<main class="login-page"><section class="login-card"><h1>${message}</h1><a class="button primary" href="/admin">返回管理后台</a></section></main>`));
});

initDatabase().then(ensureAllTemplateLanguages).then(normalizeReviewAdditionCharges).then(normalizeGenerationCharges).then(() => app.listen(port, "0.0.0.0", () => console.log(`Google Review Assistant listening on ${port}`))).catch((error) => { console.error(error); process.exit(1); });
