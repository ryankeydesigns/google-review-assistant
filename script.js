/* ===== Merchant settings: replace these values for each real merchant ===== */
const merchantConfig = {
  businessName: "Demo Coffee House",
  industry: "Cafe",
  language: "zh",
  googleReviewLink: "REPLACE_WITH_OFFICIAL_GOOGLE_REVIEW_LINK",
  logo: "images/logo.svg",
  primaryColor: "#2563EB",
  poweredBy: "RyanKey Designs",
  isDemo: true,
  redirectDelayMs: 1300
};
/* ======================================================================== */

(() => {
  "use strict";

  const ui = {
    name: document.querySelector("#business-name"),
    logo: document.querySelector("#business-logo"),
    logoWrap: document.querySelector(".logo-wrap"),
    logoFallback: document.querySelector("#logo-fallback"),
    demoLabel: document.querySelector("#demo-label"),
    button: document.querySelector("#generate-button"),
    buttonLabel: document.querySelector("#button-label"),
    status: document.querySelector("#status"),
    fallback: document.querySelector("#fallback-panel"),
    output: document.querySelector("#review-output"),
    googleLink: document.querySelector("#google-link")
  };

  let lastReview = "";
  let locked = false;

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "GR";
  }

  function applyMerchantConfig() {
    const name = merchantConfig.businessName?.trim() || "Demo Business";
    document.documentElement.style.setProperty("--brand", merchantConfig.primaryColor || "#2563EB");
    ui.name.textContent = name;
    ui.logo.src = merchantConfig.logo || "";
    ui.logo.alt = `${name} Logo`;
    ui.logoFallback.textContent = initials(name);
    ui.demoLabel.hidden = !merchantConfig.isDemo;
    document.title = `Google Review 文案助手｜${name}`;

    ui.logo.addEventListener("error", () => ui.logoWrap.classList.add("is-fallback"), { once: true });
    if (!merchantConfig.logo) ui.logoWrap.classList.add("is-fallback");
  }

  function secureRandomIndex(length) {
    if (window.crypto?.getRandomValues) {
      const values = new Uint32Array(1);
      window.crypto.getRandomValues(values);
      return values[0] % length;
    }
    return Math.floor(Math.random() * length);
  }

  function pick(items) {
    return items[secureRandomIndex(items.length)];
  }

  function generateReview() {
    const language = merchantConfig.language === "en" ? "en" : "zh";
    const library = window.reviewLibrary?.[language];
    if (!library) throw new Error("Review library is unavailable");

    let review = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      review = pick(library.openings) + pick(library.services) + pick(library.experiences) + pick(library.endings);
      const placeholder = language === "en" ? "【Business Name】" : "【商家名称】";
      review = review.replaceAll(placeholder, merchantConfig.businessName.trim());
      if (review !== lastReview) break;
    }
    lastReview = review;
    return review;
  }

  function hasValidReviewLink() {
    try {
      const url = new URL(merchantConfig.googleReviewLink);
      return url.protocol === "https:" && !merchantConfig.googleReviewLink.includes("REPLACE_WITH_");
    } catch {
      return false;
    }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    textArea.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    textArea.remove();
    if (!copied) throw new Error("Copy command failed");
    return true;
  }

  function showStatus(message, isError = false) {
    ui.status.textContent = message;
    ui.status.hidden = false;
    ui.status.classList.toggle("is-error", isError);
  }

  function showManualFallback(review, reason) {
    ui.output.textContent = review;
    ui.fallback.hidden = false;
    ui.googleLink.hidden = !hasValidReviewLink();
    if (hasValidReviewLink()) ui.googleLink.href = merchantConfig.googleReviewLink;
    showStatus(reason, true);
    ui.button.disabled = false;
    ui.buttonLabel.textContent = "再生成一段评价";
    locked = false;
  }

  async function handleGenerate() {
    if (locked) return;
    locked = true;
    ui.button.disabled = true;
    ui.fallback.hidden = true;
    ui.status.hidden = true;
    ui.buttonLabel.textContent = "正在整理评价…";

    let review;
    try {
      if (!merchantConfig.businessName?.trim()) throw new Error("Merchant name is missing");
      review = generateReview();
    } catch {
      showManualFallback("", "商家资料或评价资料库不完整，请联络商家处理。");
      return;
    }

    if (!hasValidReviewLink()) {
      showManualFallback(review, "这是 Demo 版本：尚未加入真实商家的官方 Google Review Link。评价已生成，设定链接后即可测试完整跳转流程。");
      return;
    }

    try {
      await copyText(review);
      ui.buttonLabel.textContent = "评价已复制 ✓";
      showStatus("前往 Google Review 后，请长按评价输入框并粘贴。您可以按照真实体验修改内容及选择评分。");
      window.setTimeout(() => window.location.assign(merchantConfig.googleReviewLink), merchantConfig.redirectDelayMs || 1300);
    } catch {
      showManualFallback(review, "您的浏览器无法自动复制，请长按下面的评价并选择复制。");
    }
  }

  applyMerchantConfig();
  ui.button.addEventListener("click", handleGenerate);
})();
