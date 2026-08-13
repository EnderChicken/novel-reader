/* ============================================================
   EnderRead — Novel Reader
   .txt / .epub / .pdf · themes, fonts, TOC, search, read-aloud
============================================================ */
(function () {
  "use strict";

  /* ============================================================
     Settings
  ============================================================ */
  var DEFAULT_SETTINGS = {
    theme: "light",
    font: "Literata",
    fontSize: 18,
    lineHeight: 1.8,
    width: 700,
    justify: true,
    ttsRate: 1,
    ttsVoice: "",
  };

  var FONTS = [
    { id: "Literata", stack: '"Literata", Georgia, serif' },
    { id: "Lora", stack: '"Lora", Georgia, serif' },
    { id: "EBGaramond", stack: '"EB Garamond", Georgia, serif' },
    { id: "Georgia", stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
    { id: "Inter", stack: '"Inter", system-ui, sans-serif' },
  ];

  var settings = loadSettings();
  function loadSettings() {
    try {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem("er-settings") || "{}"));
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem("er-settings", JSON.stringify(settings));
    } catch (e) {}
  }

  /* ============================================================
     State
  ============================================================ */
  var state = {
    books: [],
    progress: {},
    currentId: null,
    currentBook: null,
    chapterIndex: 0,
    openingBook: null,
    pdf: null, // cached pdf.js doc
    pdfRendering: false,
    renderToken: 0,
    tts: { playing: false, queue: [], index: 0, stopped: true },
    readingTimer: null,
    searchIndex: null,
  };

  /* ============================================================
     Tiny DOM helpers
  ============================================================ */
  function $(sel) {
    return document.querySelector(sel);
  }
  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }
  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function stripExt(name) {
    return name.replace(/\.[^.]+$/, "");
  }
  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var h = Math.floor(m / 60);
    return h > 0 ? h + "h " + (m % 60) + "m" : m + "m";
  }
  function toast(msg, kind) {
    var box = $("#toasts");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity .3s";
      setTimeout(function () {
        el.remove();
      }, 320);
    }, 2600);
  }

  /* ============================================================
     IndexedDB storage
  ============================================================ */
  var db = null;
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("enderread", 1);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "id" });
        if (!d.objectStoreNames.contains("progress")) d.createObjectStore("progress", { keyPath: "id" });
      };
      req.onsuccess = function () {
        db = req.result;
        resolve(db);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }
  function idbPut(store, val) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, "readwrite");
      t.objectStore(store).put(val);
      t.oncomplete = res;
      t.onerror = function () { rej(t.error); };
    });
  }
  function idbAll(store) {
    return new Promise(function (res, rej) {
      var r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbDel(store, key) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, "readwrite");
      t.objectStore(store).delete(key);
      t.oncomplete = res;
      t.onerror = function () { rej(t.error); };
    });
  }

  /* ============================================================
     Text decoding (.txt)
  ============================================================ */
  function decodeText(buf) {
    var bytes = new Uint8Array(buf);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      try {
        return new TextDecoder("utf-16be").decode(bytes.subarray(2));
      } catch (e) {}
    }
    var utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    var bad = (utf8.match(/\uFFFD/g) || []).length;
    if (bad > utf8.length * 0.005) {
      return new TextDecoder("windows-1252").decode(bytes);
    }
    return utf8;
  }

  var CHAPTER_RE = /^\s*(chapter|part|book|act|prologue|epilogue|preface|introduction|section|scene)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b.*$/i;

  function createChapterParser() {
    var chapters = [];
    var cur = { title: "Start", paragraphs: [] };
    var para = [];

    function flushPara() {
      var joined = para.join(" ").trim();
      if (joined) cur.paragraphs.push(joined);
      para = [];
    }
    function pushChapter() {
      flushPara();
      if (cur.paragraphs.length) chapters.push(cur);
    }

    return {
      feed: function (line) {
        line = line.trim();
        if (line === "") {
          flushPara();
          return;
        }
        if (CHAPTER_RE.test(line) && line.length < 90) {
          pushChapter();
          cur = { title: line.replace(/\s+/g, " "), paragraphs: [] };
          return;
        }
        para.push(line);
      },
      finish: function () {
        pushChapter();
        return chapters;
      },
    };
  }

  function parseTxt(buf, fileName) {
    var text = decodeText(buf).replace(/\uFEFF/g, "");
    var parser = createChapterParser();
    text.split(/\r\n|\r|\n/).forEach(parser.feed);
    var chapters = parser.finish();
    if (!chapters.length) {
      chapters.push({ title: stripExt(fileName), paragraphs: [] });
    }
    return chapters;
  }

  /* Non-blocking variant: yields to the UI thread between batches so a
     huge .txt (many MB) doesn't freeze the page while it's parsed. */
  function parseTxtAsync(buf, fileName, onProgress) {
    return new Promise(function (resolve) {
      var text = decodeText(buf).replace(/\uFEFF/g, "");
      var lines = text.split(/\r\n|\r|\n/);
      var parser = createChapterParser();
      var BATCH = 4000;
      var i = 0;

      function step() {
        var end = Math.min(i + BATCH, lines.length);
        for (; i < end; i++) parser.feed(lines[i]);
        if (onProgress) onProgress(end / lines.length);
        if (i < lines.length) {
          setTimeout(step, 0);
          return;
        }
        var chapters = parser.finish();
        if (!chapters.length) {
          chapters.push({ title: stripExt(fileName), paragraphs: [] });
        }
        resolve(chapters);
      }

      step();
    });
  }

  /* ============================================================
     ZIP / EPUB parsing
  ============================================================ */
  function concatChunks(chunks) {
    var total = chunks.reduce(function (n, c) { return n + c.byteLength; }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (c) {
      out.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    });
    return out;
  }

  async function inflateEntry(file) {
    if (file.method === 0) return file.bytes;
    if (file.method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser can't decompress EPUB files.");
      }
      var stream = new Blob([file.bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      var reader = stream.getReader();
      var chunks = [];
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
      }
      return concatChunks(chunks);
    }
    throw new Error("Unsupported zip compression (" + file.method + ")");
  }

  async function readZip(buffer) {
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

  function parseXml(text, type) {
    return new DOMParser().parseFromString(text, type || "text/xml");
  }

  function htmlToChapter(body) {
    var html = body.innerHTML;
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

    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    var text = tpl.content.textContent;
    var paragraphs = text
      .split(/\n{2,}/)
      .map(function (s) {
        return s.replace(/\s*\n\s*/g, " ").trim();
      })
      .filter(Boolean);

    return { title: title, paragraphs: paragraphs };
  }

  function stripTags(str) {
    return str.replace(/<[^>]*>/g, "");
  }

  async function parseEpub(buffer, fileName) {
    var zip = await readZip(buffer);
    var containerXml = await zip.text("META-INF/container.xml");
    if (!containerXml) throw new Error("Missing META-INF/container.xml");

    var container = parseXml(containerXml, "text/xml");
    var rootfile = container.querySelector("rootfile");
    var opfPath = rootfile ? rootfile.getAttribute("full-path") : "OEBPS/content.opf";

    var opfXml = await zip.text(opfPath);
    if (!opfXml) throw new Error("Missing content.opf");
    var opf = parseXml(opfXml, "text/xml");

    var dir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

    var manifest = {};
    var items = opf.querySelectorAll("manifest > item");
    for (var i = 0; i < items.length; i++) {
      var id = items[i].getAttribute("id");
      var href = items[i].getAttribute("href");
      if (id && href) manifest[id] = decodeURIComponent(href);
    }

    var spine = [];
    var refs = opf.querySelectorAll("spine > itemref");
    for (var j = 0; j < refs.length; j++) {
      var href2 = manifest[refs[j].getAttribute("idref")];
      if (href2) spine.push(href2);
    }
    if (!spine.length) throw new Error("No chapters found in EPUB spine.");

    var titleEl = opf.querySelector("dc\\:title") || opf.querySelector("title");
    var authorEl = opf.querySelector("dc\\:creator");
    var title = titleEl ? titleEl.textContent.trim() : stripExt(fileName);
    var author = authorEl ? authorEl.textContent.trim() : "";

    var chapters = [];
    for (var k = 0; k < spine.length; k++) {
      var path = dir + spine[k];
      var html = await zip.text(path);
      if (!html) continue;
      var doc = parseXml(html, "text/html");
      var body = doc.body;
      if (!body) continue;
      var ch = htmlToChapter(body);
      chapters.push({
        title: ch.title || stripExt(spine[k].split("/").pop()),
        paragraphs: ch.paragraphs,
      });
    }
    if (!chapters.length) throw new Error("No readable content found in EPUB.");

    return { title: title, author: author, chapters: chapters };
  }

  /* ============================================================
     PDF parsing (pdf.js)
  ============================================================ */
  var PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  /* pdf.js (~1MB) is loaded on demand only when a .pdf book is opened,
     so it doesn't block or slow down the .txt library. */
  function loadPdfjs() {
    return new Promise(function (resolve, reject) {
      if (window.pdfjsLib) return resolve();
      var s = document.createElement("script");
      s.src = PDFJS_URL;
      s.crossOrigin = "anonymous";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load the PDF engine (check internet).")); };
      document.head.appendChild(s);
    });
  }

  async function parsePdf(buf) {
    await loadPdfjs();
    var pdf = await window.pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    var meta = { title: null, author: "" };
    try {
      var m = await pdf.getMetadata();
      meta.title = m.info && m.info.Title ? m.info.Title : null;
      meta.author = m.info && m.info.Author ? m.info.Author : "";
    } catch (e) {}
    return { title: meta.title, author: meta.author, numPages: pdf.numPages };
  }

  /* ============================================================
     Import / library
  ============================================================ */
  async function refreshBooks(manual) {
    var list;
    try {
      if (manual) toast("Reloading book list\u2026");
      var url = "books.json" + (manual ? "?t=" + Date.now() : "");
      var res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      list = await res.json();
    } catch (e) {
      console.error(e);
      toast("Couldn't load books.json \u2014 re-run tools/build-books.js after adding books", "error");
      return;
    }
    state.books = list.map(function (b) {
      return {
        id: b.id,
        title: b.title || stripExt(b.fileName),
        author: "",
        type: "txt",
        fileName: b.fileName,
        fileSize: b.size || 0,
        wordCount: Math.max(1, Math.round((b.size || 0) / 6)),
        numChapters: 0,
        chapters: null,
      };
    });
    renderLibrary();
    if (manual) {
      toast("Book list reloaded \u2014 re-run tools/build-books.js after adding new books", "ok");
    }
  }

  function coverHue(title) {
    var h = 0;
    for (var i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
    return h;
  }

  function renderLibrary() {
    var grid = $("#lib-grid");
    var books = state.books.slice().sort(function (a, b) { return a.title.localeCompare(b.title); });
    var totalTime = 0;
    var totalPages = 0;

    grid.innerHTML = "";
    if (!books.length) {
      var empty = document.createElement("div");
      empty.className = "lib-empty";
      empty.innerHTML =
        "<h3>No books yet</h3>" +
        "<p>Drop converted .txt files into the books folder, then press the refresh button.</p>";
      grid.appendChild(empty);
    }

    books.forEach(function (book) {
      var prog = state.progress[book.id] || { pct: 0, readingTime: 0 };
      totalTime += prog.readingTime || 0;
      var pages = Math.max(1, Math.ceil(book.wordCount / 300));
      totalPages += pages;
      var pct = Math.round((prog.pct || 0) * 100);
      var words = Math.round((book.wordCount || 0) * (prog.pct || 0));

      var initials = book.title
        .split(/\s+/)
        .slice(0, 2)
        .map(function (w) { return w[0] || ""; })
        .join("")
        .toUpperCase();

      var card = document.createElement("div");
      card.className = "book-card";
      card.style.setProperty("--hue", coverHue(book.title));
      card.innerHTML =
        '<button class="book-btn" data-read="' + book.id + '">' +
        (pct > 0 ? "Continue" : "Read") + "</button>" +
        '<div class="book-cover"><span class="book-cover-title">' + escapeHTML(initials || "?") + "</span>" +
        '<span class="book-type">' + book.type.toUpperCase() + "</span></div>" +
        '<div class="book-meta">' +
        "<h3>" + escapeHTML(book.title) + "</h3>" +
        '<div class="book-progress"><div class="book-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<p class="book-sub">' + pct + "% read \u00B7 " + pages + " pages" +
        (words ? " \u00B7 ~" + words.toLocaleString() + " words read" : "") +
        (prog.readingTime ? " \u00B7 " + fmtTime(prog.readingTime) : "") + "</p></div>";

      grid.appendChild(card);
    });

    cardClickListener();

    $("#stat-books").textContent = books.length;
    $("#stat-time").textContent = fmtTime(totalTime);
    $("#stat-pages").textContent = totalPages;
  }

  function cardClickListener() {
    var grid = $("#lib-grid");
    grid.onclick = function (e) {
      var readBtn = e.target.closest("[data-read]");
      if (readBtn) {
        openBook(readBtn.getAttribute("data-read"));
        return;
      }
      var card = e.target.closest(".book-card");
      if (card) {
        openBook(card.querySelector("[data-read]").getAttribute("data-read"));
      }
    };
  }

  /* ============================================================
     Reader — open, render, navigate
  ============================================================ */
  async function openBook(id) {
    var book = state.books.find(function (b) { return b.id === id; });
    if (!book) return;
    if (state.openingBook === id) return;
    state.openingBook = id;
    try {
      if (!book.chapters) {
        toast("Loading \u201C" + book.title + "\u201D\u2026");
        var res = await fetch("books/" + encodeURIComponent(book.fileName));
        if (!res.ok) throw new Error("HTTP " + res.status);
        var buf = await res.arrayBuffer();
        book.chapters = await parseTxtAsync(buf, book.fileName, function (p) {
          if (state.openingBook === id && p < 1) {
            toast("Parsing \u201C" + book.title + "\u201D \u2026 " + Math.round(p * 100) + "%");
          }
        });
        book.wordCount = 0;
        book.chapters.forEach(function (c) {
          c.paragraphs.forEach(function (p2) {
            book.wordCount += p2.split(/\s+/).length;
          });
        });
        book.numChapters = book.chapters.length;
      }
    } catch (e) {
      console.error(e);
      toast("Couldn't load \u201C" + book.title + "\u201D", "error");
      state.openingBook = null;
      return;
    }
    state.openingBook = null;

    state.currentId = id;
    state.currentBook = book;
    state.chapterIndex = (state.progress[id] && state.progress[id].chapterIndex) || 0;
    state.renderToken++;

    $("#library-view").hidden = true;
    $("#reader-view").hidden = false;
    $("#rdr-book").textContent = book.title;
    $("#chapter-select").innerHTML = "";
    $("#toc-list").innerHTML = "";

    closeAllPanels();
    populateChapterSelect();
    buildTOC();
    renderChapter(state.chapterIndex, true);

    state.searchIndex = null;
    startReadingTimer();

    var pct = state.progress[id] ? state.progress[id].pct : 0;
    if (pct > 0) toast("Resumed \u2014 " + Math.round(pct * 100) + "% through", "ok");
  }

  function goBackToLibrary() {
    ttsStop();
    saveProgress();
    clearInterval(state.readingTimer);
    $("#reader-view").hidden = true;
    $("#library-view").hidden = false;
    renderLibrary();
  }

  function populateChapterSelect() {
    var sel = $("#chapter-select");
    var book = state.currentBook;
    if (!book) return;
    sel.innerHTML = "";
    var total = book.type === "pdf" ? book.numPages : book.chapters.length;
    var prefix = book.type === "pdf" ? "Page " : "Chapter ";
    for (var i = 0; i < total; i++) {
      var opt = document.createElement("option");
      opt.value = i;
      var label = book.type === "pdf"
        ? "Page " + (i + 1) + " of " + total
        : (book.chapters[i].title || "Chapter " + (i + 1));
      opt.textContent = label.length > 42 ? label.slice(0, 42) + "\u2026" : label;
      sel.appendChild(opt);
    }
    sel.value = book.type === "pdf" ? (state.pdfPage - 1) : state.chapterIndex;
  }

  function buildTOC() {
    var list = $("#toc-list");
    var book = state.currentBook;
    if (!book) return;
    list.innerHTML = "";
    var total = book.type === "pdf" ? book.numPages : book.chapters.length;
    for (var i = 0; i < total; i++) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.className = "toc-item";
      btn.textContent = book.type === "pdf"
        ? "Page " + (i + 1)
        : (book.chapters[i].title || "Chapter " + (i + 1));
      btn.dataset.index = i;
      btn.addEventListener("click", function () {
        var idx = parseInt(this.dataset.index, 10);
        if (book.type === "pdf") renderPdfPage(idx + 1, false);
        else renderChapter(idx, false);
        closePanel("panel-toc");
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    highlightCurrentTOC();
  }

  function highlightCurrentTOC() {
    var list = $("#toc-list");
    var current = state.currentBook.type === "pdf" ? (state.pdfPage - 1) : state.chapterIndex;
    $all(".toc-item").forEach(function (el) {
      el.classList.toggle("current", parseInt(el.dataset.index, 10) === current);
    });
  }

  function renderChapter(index, restore) {
    var book = state.currentBook;
    if (!book || !book.chapters) return;
    index = Math.max(0, Math.min(book.chapters.length - 1, index));
    state.chapterIndex = index;
    state.renderToken++;

    var content = $("#reader-content");
    var ch = book.chapters[index];
    var html = '<h2 class="chapter-title">' + escapeHTML(ch.title || "Chapter " + (index + 1)) + "</h2>";
    ch.paragraphs.forEach(function (p) {
      html += "<p>" + escapeHTML(p) + "</p>";
    });
    if (!ch.paragraphs.length) html += '<p class="reader-empty">(This chapter has no text.)</p>';
    content.innerHTML = html;

    $("#rdr-chapter").textContent = ch.title || "Chapter " + (index + 1);
    $("#chapter-select").value = index;
    highlightCurrentTOC();

    updateNavButtons();
    updateProgressUI();

    if (restore && state.progress[book.id] && state.progress[book.id].scrollTop) {
      var saved = state.progress[book.id].scrollTop;
      requestAnimationFrame(function () {
        window.scrollTo(0, saved);
      });
    } else {
      window.scrollTo(0, 0);
    }
  }

  function renderPdfPage(page, restore) {
    var book = state.currentBook;
    if (!book) return;
    var pdf = state.pdf;
    if (!pdf || book.id !== state.currentId) {
      loadPdfDoc(book, page, restore);
      return;
    }
    drawPdfPage(page, restore);
  }

  function loadPdfDoc(book, page, restore) {
    state.pdfRendering = true;
    $("#reader-content").innerHTML = '<p class="reader-empty">Loading PDF\u2026</p>';
    loadPdfjs()
      .then(function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return window.pdfjsLib.getDocument({ data: book.file.slice(0) }).promise;
      })
      .then(function (pdf) {
        state.pdf = pdf;
        state.pdfRendering = false;
        drawPdfPage(page, restore);
      })
      .catch(function (err) {
        console.error(err);
        state.pdfRendering = false;
        $("#reader-content").innerHTML =
          '<p class="reader-empty">Could not load this PDF' + (err.message ? " \u2014 " + err.message : "") + ".</p>";
      });
  }

  function drawPdfPage(page, restore) {
    var pdf = state.pdf;
    var book = state.currentBook;
    var token = ++state.renderToken;
    page = Math.max(1, Math.min(pdf.numPages, page));
    state.pdfPage = page;

    $("#rdr-chapter").textContent = "Page " + page + " of " + pdf.numPages;
    $("#chapter-select").value = page - 1;
    highlightCurrentTOC();

    var content = $("#reader-content");
    content.innerHTML = '<p class="reader-empty">Rendering page\u2026</p>';

    pdf.getPage(page).then(function (pg) {
      var targetWidth = Math.min(settings.width + 120, 980);
      var vp = pg.getViewport({ scale: 1 });
      var scale = targetWidth / vp.width;
      var scaled = pg.getViewport({ scale: scale });

      var container = document.createElement("div");
      container.className = "pdf-page";
      var canvas = document.createElement("canvas");
      canvas.width = scaled.width;
      canvas.height = scaled.height;
      container.appendChild(canvas);
      var label = document.createElement("p");
      label.className = "pdf-label";
      label.textContent = "Page " + page + " of " + pdf.numPages;
      container.appendChild(label);
      content.innerHTML = "";
      content.appendChild(container);

      return pg.render({ canvasContext: canvas.getContext("2d"), viewport: scaled, intent: "display" }).promise.then(function () {
        if (token !== state.renderToken) return;
        updateNavButtons();
        updateProgressUI();
        if (restore && state.progress[book.id] && state.progress[book.id].scrollTop) {
          requestAnimationFrame(function () {
            window.scrollTo(0, state.progress[book.id].scrollTop);
          });
        } else {
          window.scrollTo(0, 0);
        }
      });
    });
  }

  function nextChapter() {
    if (state.currentBook.type === "pdf") {
      if (state.pdfPage < state.currentBook.numPages) renderPdfPage(state.pdfPage + 1, false);
    } else if (state.chapterIndex < state.currentBook.chapters.length - 1) {
      renderChapter(state.chapterIndex + 1, false);
    }
  }
  function prevChapter() {
    if (state.currentBook.type === "pdf") {
      if (state.pdfPage > 1) renderPdfPage(state.pdfPage - 1, false);
    } else if (state.chapterIndex > 0) {
      renderChapter(state.chapterIndex - 1, false);
    }
  }

  function updateNavButtons() {
    var book = state.currentBook;
    var total = book.type === "pdf" ? book.numPages : book.chapters.length;
    var cur = book.type === "pdf" ? state.pdfPage : state.chapterIndex;
    $("#btn-prev").disabled = cur <= 0;
    $("#btn-next").disabled = cur >= total - 1;
  }

  function updateProgressUI() {
    var book = state.currentBook;
    if (!book) return;
    var total = book.type === "pdf" ? book.numPages : book.chapters.length;
    var cur = book.type === "pdf" ? state.pdfPage : state.chapterIndex;
    var doc = document.documentElement;
    var ratio = total > 1 ? cur / (total - 1) : 0;
    var pct = Math.min(0.999, ratio + (doc.scrollTop / Math.max(1, doc.scrollHeight - doc.clientHeight)) * (1 / total));
    $("#rdr-progress-fill").style.width = (pct * 100).toFixed(1) + "%";
    var label = book.type === "pdf"
      ? "Page " + cur + " / " + total
      : "Chapter " + (cur + 1) + " / " + total;
    $("#rdr-progress-text").textContent = label + " \u00B7 " + Math.round(pct * 100) + "%";
  }

  /* ============================================================
     Progress persistence
  ============================================================ */
  function saveProgress() {
    var id = state.currentId;
    if (!id) return;
    var book = state.currentBook;
    var prog = state.progress[id] || { id: id, readingTime: 0, lastRead: Date.now() };
    prog.lastRead = Date.now();

    if (book.type === "pdf") {
      prog.page = state.pdfPage || 1;
      prog.pct = (state.pdfPage || 1) / book.numPages;
      prog.scrollTop = document.documentElement.scrollTop;
    } else {
      var total = book.chapters.length;
      var doc = document.documentElement;
      var sr = total > 1 ? doc.scrollTop / Math.max(1, doc.scrollHeight - doc.clientHeight) : 0;
      prog.pct = Math.min(0.999, (state.chapterIndex + sr) / total);
      prog.chapterIndex = state.chapterIndex;
      prog.scrollTop = doc.scrollTop;
    }
    state.progress[id] = prog;
    idbPut("progress", prog);
  }

  function startReadingTimer() {
    clearInterval(state.readingTimer);
    state.readingTimer = setInterval(function () {
      var prog = state.progress[state.currentId];
      if (!prog) return;
      prog.readingTime = (prog.readingTime || 0) + 15;
      idbPut("progress", prog);
    }, 15000);
  }

  /* ============================================================
     Panels
  ============================================================ */
  function openPanel(id) {
    closeAllPanels();
    $("#" + id).hidden = false;
    $("#backdrop").hidden = false;
    if (id === "panel-settings") applySettingsUI();
    if (id === "panel-search") setTimeout(function () { $("#search-input").focus(); }, 60);
    if (id === "panel-toc") highlightCurrentTOC();
  }
  function closePanel(id) {
    $("#" + id).hidden = true;
    if ($all(".panel:not([hidden])").length === 0) $("#backdrop").hidden = true;
  }
  function closeAllPanels() {
    $all(".panel").forEach(function (p) { p.hidden = true; });
    $("#backdrop").hidden = true;
  }

  /* ============================================================
     Settings application
  ============================================================ */
  function applySettings() {
    document.body.dataset.theme = settings.theme;
    var content = $("#reader-content");
    if (!content) return;
    var font = FONTS.find(function (f) { return f.id === settings.font; }) || FONTS[0];
    content.style.fontFamily = font.stack;
    content.style.fontSize = settings.fontSize + "px";
    content.style.lineHeight = settings.lineHeight;
    content.style.maxWidth = settings.width + "px";
    content.style.textAlign = settings.justify ? "justify" : "left";
    saveSettings();
  }

  function applySettingsUI() {
    $all(".theme-swatch").forEach(function (el) {
      el.classList.toggle("active", el.dataset.theme === settings.theme);
    });
    $all(".font-opt").forEach(function (el) {
      el.classList.toggle("active", el.dataset.font === settings.font);
    });
    $("#size-range").value = settings.fontSize;
    $("#size-val").textContent = settings.fontSize;
    $("#lh-range").value = settings.lineHeight;
    $("#lh-val").textContent = settings.lineHeight.toFixed(1);
    $("#width-range").value = settings.width;
    $("#width-val").textContent = settings.width;
    $("#rate-range").value = settings.ttsRate;
    $("#rate-val").textContent = settings.ttsRate.toFixed(1) + "\u00D7";
    $("#justify-toggle").setAttribute("aria-checked", String(settings.justify));
  }

  function buildVoiceList() {
    var sel = $("#voice-select");
    if (!window.speechSynthesis) return;
    var voices = window.speechSynthesis.getVoices().filter(function (v) {
      return /^en/i.test(v.lang);
    });
    sel.innerHTML = "";
    if (!voices.length) {
      var none = document.createElement("option");
      none.textContent = "No English voices available";
      sel.appendChild(none);
      return;
    }
    voices.forEach(function (v, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = v.name + " (" + v.lang + ")";
      sel.appendChild(opt);
    });
    var idx = voices.findIndex(function (v) { return v.name === settings.ttsVoice; });
    sel.value = String(idx >= 0 ? idx : 0);
  }

  function getSelectedVoice() {
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
    if (!voices.length) return null;
    var idx = parseInt($("#voice-select").value || "0", 10);
    return voices[idx] || voices[0] || null;
  }

  /* ============================================================
     Search
  ============================================================ */
  function buildSearchIndex() {
    if (state.searchIndex) return state.searchIndex;
    var book = state.currentBook;
    if (!book || !book.chapters) return [];
    var index = [];
    book.chapters.forEach(function (ch, ci) {
      ch.paragraphs.forEach(function (p, pi) {
        index.push({ chapter: ci, para: pi, text: p, lower: p.toLowerCase() });
      });
    });
    state.searchIndex = index;
    return index;
  }

  function runSearch(query) {
    var q = query.trim().toLowerCase();
    var results = $("#search-results");
    if (!q) {
      results.innerHTML = '<p class="search-empty">Type to search this book.</p>';
      return;
    }
    var index = buildSearchIndex();
    var found = [];
    for (var i = 0; i < index.length && found.length < 60; i++) {
      var item = index[i];
      var pos = item.lower.indexOf(q);
      if (pos === -1) continue;
      var start = Math.max(0, pos - 40);
      var end = Math.min(item.text.length, pos + q.length + 60);
      var snippet = (start > 0 ? "\u2026" : "") + item.text.slice(start, end) + (end < item.text.length ? "\u2026" : "");
      var hl = escapeHTML(snippet).replace(new RegExp("(" + escapeRegExp(query.trim()) + ")", "gi"), "<em>$1</em>");
      found.push({
        chapter: item.chapter,
        para: item.para,
        chapterTitle: state.currentBook.chapters[item.chapter].title || "Chapter " + (item.chapter + 1),
        snippet: hl,
      });
    }

    if (!found.length) {
      results.innerHTML = '<p class="search-empty">No matches for \u201C' + escapeHTML(query.trim()) + "\u201D.</p>";
      return;
    }

    results.innerHTML = found
      .map(function (r) {
        return (
          '<button class="search-result" data-chapter="' + r.chapter + '" data-para="' + r.para + '">' +
          '<div class="sr-chapter">' + escapeHTML(r.chapterTitle) + "</div>" +
          '<div class="sr-text">' + r.snippet + "</div>" +
          "</button>"
        );
      })
      .join("");
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function jumpToSearchResult(chapter, para, query) {
    renderChapter(chapter, false);
    var content = $("#reader-content");
    var paragraphs = content.querySelectorAll("p");
    var target = paragraphs[para];
    if (!target) return;
    highlightMatches(target, query);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function highlightMatches(paraEl, query) {
    if (!query) return;
    var text = paraEl.textContent;
    var re = new RegExp("(" + escapeRegExp(query) + ")", "gi");
    var html = text.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
    paraEl.innerHTML = html.replace(re, "<mark>$1</mark>");
  }

  /* ============================================================
     Read-aloud (TTS)
  ============================================================ */
  function sentenceSplit(text) {
    var parts = text.match(/[^.!?\u2026]+[.!?\u2026]*["'\u2019\u201D)]*|$/g) || [];
    return parts.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function ttsToggle() {
    if (state.tts.stopped) ttsStart();
    else if (state.tts.playing) ttsPause();
    else ttsResume();
  }

  function ttsStart() {
    if (!window.speechSynthesis) {
      toast("Read-aloud is not supported in this browser.", "error");
      return;
    }
    var book = state.currentBook;
    if (book.type === "pdf") {
      toast("Read-aloud works with .txt and .epub books.", "error");
      return;
    }
    var query = $("#search-input").value;
    if (query) $("#search-input").value = "";

    state.tts.stopped = false;
    state.tts.playing = true;
    buildTtsQueue();
    $("#tts-bar").hidden = false;
    setTtsPlayIcon(true);
    if (state.tts.queue.length === 0) {
      ttsStop();
      return;
    }
    speechSynthesis.cancel();
    state.tts.index = 0;
    speakNext();
  }

  function buildTtsQueue() {
    var book = state.currentBook;
    var content = $("#reader-content");
    var paras = content.querySelectorAll("p");
    var queue = [];
    for (var i = 0; i < paras.length; i++) {
      var text = paras[i].textContent.trim();
      if (!text) continue;
      sentenceSplit(text).forEach(function (s) {
        queue.push({ el: paras[i], sentence: s });
      });
    }
    state.tts.queue = queue;
    state.tts.index = 0;
  }

  function clearTtsHighlights() {
    $all("#reader-content mark.tts-on").forEach(function (m) {
      var parent = m.parentNode;
      var text = parent.textContent;
      parent.innerHTML = escapeHTML(text);
    });
  }

  function highlightSentence(paraEl, sentence) {
    clearTtsHighlights();
    var text = paraEl.textContent;
    var idx = text.indexOf(sentence);
    if (idx === -1) {
      paraEl.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var before = escapeHTML(text.slice(0, idx));
    var mid = escapeHTML(sentence);
    var after = escapeHTML(text.slice(idx + sentence.length));
    paraEl.innerHTML = before + '<mark class="tts-on">' + mid + "</mark>" + after;
    paraEl.scrollIntoView({ block: "center", behavior: "smooth" });
    $("#tts-status").textContent = "\u201C" + sentence.slice(0, 42) + (sentence.length > 42 ? "\u2026" : "") + "\u201D";
  }

  function speakNext() {
    if (state.tts.stopped) return;
    var queue = state.tts.queue;
    if (state.tts.index >= queue.length) {
      if (state.chapterIndex < state.currentBook.chapters.length - 1) {
        renderChapter(state.chapterIndex + 1, false);
        buildTtsQueue();
        speakNext();
      } else {
        ttsStop();
        toast("Finished the book \u2014 well read!", "ok");
      }
      return;
    }
    var item = queue[state.tts.index];
    var utterance = new SpeechSynthesisUtterance(item.sentence);
    utterance.rate = settings.ttsRate;
    var voice = getSelectedVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = function () {
      if (state.tts.stopped) return;
      state.tts.index++;
      speakNext();
    };
    utterance.onerror = function () {
      if (state.tts.stopped) return;
      state.tts.index++;
      speakNext();
    };
    highlightSentence(item.el, item.sentence);
    speechSynthesis.speak(utterance);
  }

  function ttsPause() {
    state.tts.playing = false;
    speechSynthesis.pause();
    setTtsPlayIcon(false);
    $("#tts-status").textContent = "Paused \u2014 tap play to continue";
  }
  function ttsResume() {
    state.tts.playing = true;
    speechSynthesis.resume();
    setTtsPlayIcon(true);
  }
  function ttsStop() {
    state.tts.stopped = true;
    state.tts.playing = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    $("#tts-bar").hidden = true;
    clearTtsHighlights();
  }
  function setTtsPlayIcon(playing) {
    $("#tts-play-icon").innerHTML = playing
      ? '<path d="M8 5v14l11-7Z"/>'
      : '<path d="M8 5v14l5-7Z"/><path d="M14 6l8 6-8 6Z"/>';
  }

  /* ============================================================
     Events
  ============================================================ */
  function bindEvents() {
    /* "Add book" shows the owner's Discord for sending books */
    var DISCORD_USERNAME = "EnderChicken";

    function copyDiscord() {
      var done = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(DISCORD_USERNAME).then(
          function () { done = true; },
          function () {}
        );
      }
      if (!done) {
        var ta = document.createElement("textarea");
        ta.value = DISCORD_USERNAME;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        ta.remove();
      }
      toast("Send your book to @" + DISCORD_USERNAME + " on Discord \u2014 it'll be added here");
    }
    $("#btn-add").addEventListener("click", copyDiscord);

    /* reload the books.json manifest (regenerate with tools/build-books.js) */
    $("#btn-refresh").addEventListener("click", function () {
      refreshBooks(true);
    });

    /* reader nav */
    $("#btn-back").addEventListener("click", goBackToLibrary);
    $("#btn-prev").addEventListener("click", prevChapter);
    $("#btn-next").addEventListener("click", nextChapter);
    $("#chapter-select").addEventListener("change", function () {
      var idx = parseInt(this.value, 10);
      if (state.currentBook.type === "pdf") renderPdfPage(idx + 1, false);
      else renderChapter(idx, false);
    });

    /* panels */
    $("#btn-toc").addEventListener("click", function () { openPanel("panel-toc"); });
    $("#btn-search").addEventListener("click", function () { openPanel("panel-search"); });
    $("#btn-settings").addEventListener("click", function () { openPanel("panel-settings"); });
    $("#btn-tts").addEventListener("click", ttsToggle);
    $all("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", function () { closePanel(btn.dataset.close); });
    });
    $("#backdrop").addEventListener("click", closeAllPanels);

    /* TTS bar */
    $("#tts-play").addEventListener("click", ttsToggle);
    $("#tts-stop").addEventListener("click", ttsStop);
    $("#tts-close").addEventListener("click", ttsStop);

    /* search */
    var debounceTimer = null;
    $("#search-input").addEventListener("input", function () {
      clearTimeout(debounceTimer);
      var self = this;
      debounceTimer = setTimeout(function () { runSearch(self.value); }, 250);
    });
    $("#search-results").addEventListener("click", function (e) {
      var btn = e.target.closest(".search-result");
      if (!btn) return;
      jumpToSearchResult(
        parseInt(btn.dataset.chapter, 10),
        parseInt(btn.dataset.para, 10),
        $("#search-input").value,
      );
      closePanel("panel-search");
    });

    /* settings */
    $("#theme-row").addEventListener("click", function (e) {
      var sw = e.target.closest(".theme-swatch");
      if (!sw) return;
      settings.theme = sw.dataset.theme;
      applySettings();
      applySettingsUI();
    });
    $("#font-row").addEventListener("click", function (e) {
      var opt = e.target.closest(".font-opt");
      if (!opt) return;
      settings.font = opt.dataset.font;
      applySettings();
      applySettingsUI();
    });
    $("#size-range").addEventListener("input", function () {
      settings.fontSize = parseInt(this.value, 10);
      $("#size-val").textContent = settings.fontSize;
      applySettings();
    });
    $("#lh-range").addEventListener("input", function () {
      settings.lineHeight = parseFloat(this.value);
      $("#lh-val").textContent = settings.lineHeight.toFixed(1);
      applySettings();
    });
    $("#width-range").addEventListener("input", function () {
      settings.width = parseInt(this.value, 10);
      $("#width-val").textContent = settings.width;
      applySettings();
    });
    $("#justify-toggle").addEventListener("click", function () {
      settings.justify = !settings.justify;
      this.setAttribute("aria-checked", String(settings.justify));
      applySettings();
    });
    $("#rate-range").addEventListener("input", function () {
      settings.ttsRate = parseFloat(this.value);
      $("#rate-val").textContent = settings.ttsRate.toFixed(1) + "\u00D7";
      saveSettings();
    });
    $("#voice-select").addEventListener("change", function () {
      var voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      var v = voices[parseInt(this.value, 10)];
      if (v) settings.ttsVoice = v.name;
      saveSettings();
    });

    /* scroll progress + save */
    var scrollTimer = null;
    window.addEventListener("scroll", function () {
      if (state.currentBook) updateProgressUI();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveProgress, 500);
    }, { passive: true });

    /* keyboard */
    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (!$("#reader-view").hidden) {
        if (e.key === "ArrowRight") nextChapter();
        else if (e.key === "ArrowLeft") prevChapter();
        else if (e.key === "Escape") closeAllPanels();
      }
    });

    /* mobile swipe */
    var touchX = null;
    var rdrBody = $(".rdr-body");
    rdrBody.addEventListener("touchstart", function (e) {
      touchX = e.changedTouches[0].clientX;
    }, { passive: true });
    rdrBody.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 70) {
        if (dx < 0) nextChapter();
        else prevChapter();
      }
      touchX = null;
    }, { passive: true });

    /* save on leave */
    window.addEventListener("pagehide", saveProgress);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") saveProgress();
    });

    /* voices */
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = buildVoiceList;
    }
  }

  /* ============================================================
     Init
  ============================================================ */
  async function init() {
    applySettings();
    bindEvents();
    buildVoiceList();

    try {
      await openDB();
      var progList = await idbAll("progress");
      progList.forEach(function (p) { state.progress[p.id] = p; });
    } catch (e) {
      toast("Could not open local storage.", "error");
    }
    await refreshBooks(false);

    /* open a book directly from the URL (?book=fileName), e.g. from /books */
    var target = new URLSearchParams(window.location.search).get("book");
    if (target && state.books.some(function (b) { return b.id === target; })) {
      openBook(target);
    }
  }

  init();

  /* Exposed internals (used by automated tests) */
  window.__enderread = {
    decodeText: decodeText,
    parseTxt: parseTxt,
    parseTxtAsync: parseTxtAsync,
    parseEpub: parseEpub,
    readZip: readZip,
    sentenceSplit: sentenceSplit,
    refreshBooks: refreshBooks,
    openBook: openBook,
    renderChapter: renderChapter,
    state: state,
    settings: settings,
  };
})();
