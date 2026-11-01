// Real pages for links read without running the app (Google Play's checks, search
// engines): /privacy, /terms and /delete-account answer 200 with their whole text.
// GitHub Pages serves dist/privacy.html at /privacy with no redirect. The legal
// text comes from the same source the app shows.
// Usage, after the web build: node scripts/build-static-pages.mjs [dist]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const dist = process.argv[2] ?? "dist";
const work = mkdtempSync(join(tmpdir(), "prosm-legal-"));
const bundle = join(work, "legal.mjs");
buildSync({ entryPoints: ["src/modules/legal/legalContent.ts"], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
const { LEGAL_DOCUMENTS } = await import(pathToFileURL(bundle).href);
rmSync(work, { recursive: true, force: true });

const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const list = (items) => `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`;

function block(item) {
  if (item.type === "paragraph") return `<p>${escape(item.text)}</p>`;
  if (item.type === "bullets") return list(item.items);
  const head = item.head.map((cell) => `<th>${escape(cell)}</th>`).join("");
  const rows = item.rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("");
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function article(doc, language) {
  const sections = doc.sections
    .map((section) => {
      const paragraphs = (section.paragraphs ?? []).map((text) => `<p>${escape(text)}</p>`).join("");
      const bullets = section.bullets ? list(section.bullets) : "";
      const blocks = (section.blocks ?? []).map(block).join("");
      return `<h2>${escape(section.heading)}</h2>${paragraphs}${bullets}${blocks}`;
    })
    .join("\n");
  return `<article lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}" id="${language}">
<h1>${escape(doc.title)}</h1>
<p class="updated">${escape(doc.updated)}</p>
${doc.intro.map((text) => `<p>${escape(text)}</p>`).join("\n")}
${sections}
</article>`;
}

function page(title, description, body) {
  return `<!doctype html>
<html lang="ar">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="icon" href="/favicon.ico">
<style>
body{margin:0;background:#f7f8fa;color:#0f172a;font:16px/1.7 Arial,Tahoma,sans-serif}
main{max-width:820px;margin:0 auto;padding:24px 16px}
article{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:24px;margin-bottom:24px}
nav a{margin-inline-end:16px;color:#1e6fd9}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin-top:28px}
.updated{color:#64748b;font-size:14px}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #cbd5e1;padding:8px;text-align:start;vertical-align:top}
</style>
</head>
<body><main>
<nav><a href="#ar">العربية</a><a href="#en">English</a><a href="/">PROSM Time</a></nav>
${body}
</main></body>
</html>
`;
}

const { privacy, terms } = LEGAL_DOCUMENTS;
writeFileSync(join(dist, "privacy.html"), page("PROSM Time Privacy Policy | سياسة الخصوصية", "PROSM Time Privacy Policy", `${article(privacy.ar, "ar")}\n${article(privacy.en, "en")}`));
writeFileSync(join(dist, "terms.html"), page("PROSM Time Terms of Use | شروط الاستخدام", "PROSM Time Terms of Use", `${article(terms.ar, "ar")}\n${article(terms.en, "en")}`));

const deletion = `<article lang="ar" dir="rtl" id="ar">
<h1>حذف حساب PROSM Time</h1>
<p>تطبيق PROSM Time من PROSM. تستطيع طلب حذف حسابك وبياناتك بإحدى الطريقتين:</p>
<h2>من داخل التطبيق</h2>
<p>من قائمة المستخدم اختر «حذف حسابي»، وستُطلب كلمة المرور مرة أخرى. يتوقف دخولك نهائيًا وتُحذف بياناتك فورًا.</p>
<h2>إن لم يعد لديك التطبيق</h2>
<p>أرسل إلى <a href="mailto:support@prosm.net?subject=%D8%B7%D9%84%D8%A8%20%D8%AD%D8%B0%D9%81%20%D8%AD%D8%B3%D8%A7%D8%A8%20PROSM%20Time">support@prosm.net</a> رسالة بعنوان «طلب حذف حساب PROSM Time» من بريدك المسجّل مع اسم مؤسستك. نتحقق من هويتك ونحذف بياناتك دون تأخير غير مبرّر، وفي مهلة لا تتجاوز 30 يومًا.</p>
<h2>ما يُحذف</h2>
<ul><li>الاسم والبريد والصورة الشخصية</li><li>صور الحضور والانصراف</li><li>مسار الموقع</li><li>مستندات الإجازات</li><li>الأجهزة والإشعارات</li></ul>
<h2>ما يبقى</h2>
<p>تحتفظ مؤسستك بسجلات العمل والرواتب التي يلزمها القانون (الحضور والكشوف والإجازات والبدلات) دون اسمك، باسم «مستخدم محذوف»، للمدة المذكورة في <a href="/privacy">سياسة الخصوصية</a>.</p>
<p>حساب صاحب الشركة تتبعه المؤسسة كلها، ويُحذف بطلب إلى support@prosm.net.</p>
</article>
<article lang="en" dir="ltr" id="en">
<h1>Delete your PROSM Time account</h1>
<p>PROSM Time is an app by PROSM. You can ask for your account and data to be deleted in either of these ways:</p>
<h2>In the app</h2>
<p>In the user menu choose "Delete my account" and re-enter your password. Your access ends permanently and your data is deleted immediately.</p>
<h2>If you no longer have the app</h2>
<p>Email <a href="mailto:support@prosm.net?subject=PROSM%20Time%20account%20deletion%20request">support@prosm.net</a> with the subject "PROSM Time account deletion request" from your registered email, with your organisation's name. We verify your identity and delete your data without undue delay and within 30 days.</p>
<h2>What is deleted</h2>
<ul><li>Your name, email and profile photo</li><li>Attendance photos</li><li>Location trail</li><li>Leave documents</li><li>Devices and notifications</li></ul>
<h2>What is kept</h2>
<p>Your organisation keeps the work and payroll records it is legally required to keep (attendance, timesheets, leave, allowances) without your name, under "Deleted user", for the period in the <a href="/privacy">Privacy Policy</a>.</p>
<p>A company owner's account governs the whole organisation and is deleted on request to support@prosm.net.</p>
</article>`;
writeFileSync(join(dist, "delete-account.html"), page("Delete your PROSM Time account | حذف حساب PROSM Time", "How to delete your PROSM Time account and data", deletion));
console.log("static pages written");
