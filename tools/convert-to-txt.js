/* Convert EPUB or PDF books to the plain-text format that the novel-reader
   app's txt parser understands:
     - chapter headings are lines matching CHAPTER_RE (e.g. "Chapter 1"),
       kept under 90 characters
     - paragraphs are separated by blank lines
   Usage:
     node convert-to-txt.js book.epub
     node convert-to-txt.js book.pdf
   Output is written next to the input with a .txt extension.
*/

const fs = require("fs");
const path = require("path");

const CHAPTER_RE = /^\s*(chapter|part|book|act|prologue|epilogue|preface|introduction|section|scene)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b.*$/i;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  emsp: "\u2003",
  ensp: "\u2002",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  bull: "\u2022",
  middot: "\u00b7",
  sect: "\u00a7",
  para: "\u00b6",
  dagger: "\u2020",
  Dagger: "\u2021",
  laquo: "\u00ab",
  raquo: "\u00bb",
  szlig: "\u00df",
  brvbar: "\u00a6",
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, e) {
    if (e[0] === "#") {
      var n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

function stripTags(str) {
  return str.replace(/<[^>]*>/g, "");
}

/* Mirrors the app's htmlToChapter (including its title-extraction order). */
function htmlToText(html) {
  html = html.replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, "");
  html = html.replace(/<head[\s\S]*?<\/head>/gi, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<(style|nav|header|footer)[\s\S]*?<\/\1>/gi, "");

  var title = "";
  var m = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (m) {
    title = stripTags(m[1]).trim();
    html = html.replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/i, "");
  }

  html = html.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|td)>/gi, "\n\n");
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = decodeEntities(stripTags(html));

  var paragraphs = html
    .split(/\n{2,}/)
    .map(function (s) {
      return s.replace(/\s*\n\s*/g, " ").trim();
    })
    .filter(Boolean);

  return { title: decodeEntities(title).trim(), paragraphs: paragraphs };
}

/* ---- ZIP / EPUB reading (same algorithm as the app's readZip) ---- */

async function inflateEntry(file) {
  if (file.method === 0) return file.bytes;
  if (file.method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This version of Node cannot decompress EPUB files (need Node 18+).");
    }
    var stream = new Blob([file.bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var res = await reader.read();
      if (res.done) break;
      chunks.push(res.value);
      total += res.value.byteLength;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (c) {
      out.set(c, offset);
      offset += c.byteLength;
    });
    return out;
  }
  throw new Error("Unsupported zip compression method: " + file.method);
}

function readZip(buffer) {
  var dv = new DataView(buffer);
  var eocd = -1;
  for (var i = buffer.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid EPUB (no zip header).");

  var cdSize = dv.getUint32(eocd + 12, true);
  var cdOffset = dv.getUint32(eocd + 16, true);
  var entries = [];
  var p = cdOffset;
  var end = cdOffset + cdSize;

  while (p < end && p + 46 <= buffer.byteLength) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var compSize = dv.getUint32(p + 20, true);
    var nameLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var commentLen = dv.getUint16(p + 32, true);
    var localOffset = dv.getUint32(p + 42, true);
    var nameBytes = new Uint8Array(buffer, p + 46, nameLen);
    var name = new TextDecoder().decode(nameBytes);
    entries.push({ name: name, method: method, compSize: compSize, localOffset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  var files = {};
  entries.forEach(function (e) {
    var lh = e.localOffset;
    if (lh + 30 > buffer.byteLength) return;
    var lnameLen = dv.getUint16(lh + 26, true);
    var lextraLen = dv.getUint16(lh + 28, true);
    var dataStart = lh + 30 + lnameLen + lextraLen;
    files[e.name] = { method: e.method, bytes: new Uint8Array(buffer, dataStart, e.compSize) };
  });

  return {
    entries: files,
    text: async function (name) {
      var f = files[name];
      if (!f) return null;
      var bytes = await inflateEntry(f);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    },
  };
}

function attr(tag, name) {
  var m = new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', "i").exec(tag);
  return m ? m[1] : null;
}

async function parseEpub(buf) {
  var zip = await readZip(buf);

  var containerXml = await zip.text("META-INF/container.xml");
  if (!containerXml) throw new Error("Missing META-INF/container.xml");
  var rootMatch = /<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(containerXml);
  var opfPath = rootMatch ? rootMatch[1] : "OEBPS/content.opf";

  var opfXml = await zip.text(opfPath);
  if (!opfXml) throw new Error("Missing content.opf");
  var dir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  var manifest = {};
  var itemRe = /<item\b[^>]*>/gi;
  var it;
  while ((it = itemRe.exec(opfXml))) {
    var id = attr(it[0], "id");
    var href = attr(it[0], "href");
    if (id && href) manifest[id] = decodeURIComponent(href);
  }

  var spine = [];
  var refRe = /<itemref\b[^>]*>/gi;
  var ref;
  while ((ref = refRe.exec(opfXml))) {
    var idref = attr(ref[0], "idref");
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }
  if (!spine.length) throw new Error("No chapters found in EPUB spine.");

  var titleRe = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfXml);
  var authorRe = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opfXml);
  var title = titleRe ? decodeEntities(stripTags(titleRe[1])).trim() : "";
  var author = authorRe ? decodeEntities(stripTags(authorRe[1])).trim() : "";

  var chapters = [];
  for (var k = 0; k < spine.length; k++) {
    var html = await zip.text(dir + spine[k]);
    if (!html) continue;
    var ch = htmlToText(html);
    if (!ch.paragraphs.length) continue;
    chapters.push({ title: ch.title, paragraphs: ch.paragraphs });
  }
  if (!chapters.length) throw new Error("No readable content found in EPUB.");

  return { title: title, author: author, chapters: chapters };
}

/* ---- PDF reading (best effort text extraction) ---- */

async function parsePdf(buf) {
  var parsePdf;
  try {
    parsePdf = require("pdf-parse");
  } catch (e) {
    throw new Error("pdf-parse is not installed. Run: cd tools && npm install");
  }
  var data = await parsePdf(buf);
  var text = data.text.replace(/\r\n?/g, "\n");

  var chapters = [];
  var cur = { title: "", paragraphs: [] };
  var para = [];

  function flushPara() {
    var joined = para.join(" ").replace(/\s+/g, " ").trim();
    if (joined) cur.paragraphs.push(joined);
    para = [];
  }
  function pushChapter() {
    flushPara();
    if (cur.paragraphs.length) chapters.push(cur);
  }

  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === "") {
      flushPara();
      continue;
    }
    if (line.length < 90 && CHAPTER_RE.test(line)) {
      pushChapter();
      cur = { title: line, paragraphs: [] };
      continue;
    }
    para.push(line);
  }
  pushChapter();

  if (!chapters.length) throw new Error("No text could be extracted from the PDF.");
  return { title: "", author: "", chapters: chapters };
}

/* ---- Output formatting ---- */

function headingFor(title, n) {
  var t = (title || "").replace(/\s+/g, " ").trim();
  if (t && t.length < 90 && CHAPTER_RE.test(t)) return t;
  if (t) return "Chapter " + n + " \u2014 " + t;
  return "Chapter " + n;
}

function writeTxt(chapters) {
  var parts = [];
  chapters.forEach(function (c, i) {
    parts.push(headingFor(c.title, i + 1));
    parts.push("");
    c.paragraphs.forEach(function (p) {
      parts.push(p);
      parts.push("");
    });
  });
  return parts.join("\n");
}

async function main() {
  var input = process.argv[2];
  if (!input) {
    console.error("Usage: node convert-to-txt.js <book.epub|book.pdf>");
    process.exit(1);
  }
  var ext = path.extname(input).toLowerCase();
  var buf = fs.readFileSync(input);

  var parsed;
  if (ext === ".epub") {
    var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parsed = await parseEpub(ab);
  } else if (ext === ".pdf") parsed = await parsePdf(buf);
  else {
    console.error("Unsupported file type: " + ext + " (use .epub or .pdf)");
    process.exit(1);
  }

  var outPath = input.replace(/\.[^.]+$/, "") + ".txt";
  fs.writeFileSync(outPath, writeTxt(parsed.chapters));
  console.log("Wrote " + outPath + " (" + parsed.chapters.length + " chapter(s))");
}

main().catch(function (e) {
  console.error("Error: " + e.message);
  process.exit(1);
});
