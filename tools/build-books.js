/* Scan the books/ folder and regenerate the static site files that
   static hosting needs (the site is fully static — no Node server):
     - books.html  — listing page with every book baked in
     - books.json  — manifest used by the reader app's library
   Usage:  node build-books.js
   Re-run it after adding/removing files in books/. */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BOOKS_DIR = path.join(ROOT, "books");
const OUT_HTML = path.join(ROOT, "books.html");
const OUT_JSON = path.join(ROOT, "books.json");

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? String(Math.round(n)) : n.toFixed(1)) + " " + units[i];
}

function coverHue(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return h;
}

function initials(title) {
  return title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
}

const books = fs
  .readdirSync(BOOKS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.txt$/i.test(e.name))
  .map((e) => {
    const st = fs.statSync(path.join(BOOKS_DIR, e.name));
    return {
      id: e.name,
      title: e.name.replace(/\.[^.]+$/, ""),
      fileName: e.name,
      size: st.size,
    };
  })
  .sort((a, b) => a.title.localeCompare(b.title));

const cards = books
  .map((b) => {
    return (
      '<a class="book-card" style="--hue:' + coverHue(b.title) + '" href="/?book=' +
      encodeURIComponent(b.fileName) + '">' +
      '<div class="book-cover"><span class="book-cover-title">' + esc(initials(b.title)) + "</span>" +
      '<span class="book-type">TXT</span></div>' +
      '<div class="book-meta">' +
      "<h3>" + esc(b.title) + "</h3>" +
      '<p class="book-sub">' + fmtSize(b.size) + " \u00B7 Read online</p>" +
      "</div></a>"
    );
  })
  .join("\n");

const body =
  books.length > 0
    ? '<section class="lib-grid">\n' + cards + "\n</section>"
    : '<div class="lib-empty"><h3>No books yet</h3><p>The books folder is empty.</p></div>';

const html =
  '<!DOCTYPE html>\n' +
  '<html lang="en">\n' +
  "<head>\n" +
  '  <meta charset="UTF-8" />\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
  "  <title>Books \u2014 EnderRead</title>\n" +
  '  <link rel="stylesheet" href="style.css" />\n' +
  "</head>\n" +
  '<body data-theme="light">\n' +
  '\n  <div class="view">\n' +
  '    <header class="lib-header">\n' +
  '      <div class="lib-header-inner">\n' +
  '        <a href="/" class="brand">\n' +
  '          <span class="brand-mark">\u2712</span>\n' +
  '          <span class="brand-text">EnderRead</span>\n' +
  "        </a>\n" +
  '        <a class="btn-secondary" href="/">Back to reader</a>\n' +
  "      </div>\n" +
  "    </header>\n" +
  '\n    <main class="lib-main">\n' +
  '      <div class="lib-stats">\n' +
  '        <div class="stat-card"><p class="stat-num">' + books.length + '</p><p class="stat-lbl">Books</p></div>\n' +
  "      </div>\n" +
  "\n" + body + "\n" +
  "    </main>\n" +
  "  </div>\n" +
  "</body>\n" +
  "</html>\n";

fs.writeFileSync(OUT_JSON, JSON.stringify(books, null, 2) + "\n");
fs.writeFileSync(OUT_HTML, html);
console.log("Wrote " + OUT_HTML + " and " + OUT_JSON + " (" + books.length + " book(s))");
