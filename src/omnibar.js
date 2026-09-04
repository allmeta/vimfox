// vimfox/src/omnibar.js — the `o` / `:` / `gt` / `b` command palette, and the
// ranking behind it.
//
// Ported from Vimium 2.4.2, not approximated: `wordRelevancy` + `recencyScore`
// from ranking.js, and the domain completer's fixed relevancy from
// completers.js. Read the xpi before changing any of it — the constants are
// load-bearing. DOMAIN_RELEVANCY of 2.0 is what puts raider.io above a page
// merely titled "raid", and it is NOT in ranking.js.
//
// A chrome element, not an injected iframe: it renders above every page
// including about:*, survives fullscreen, and no page CSS can touch it.

"use strict";

this.vimfoxOmnibar = (vf) => {
  const {
    win, document, gBrowser, HTML, log, PlacesUtils,
    setMode, runEx, deleteLineIn,
  } = vf;

  // Wrap query matches in <span class="match">, which Vimium's CSS renders
  // bold (and white in dark mode). Built from DOM nodes, never innerHTML —
  // this is a chrome document and titles/URLs are untrusted text.
  function highlight(parent, text, tokens) {
    parent.textContent = "";
    const lower = text.toLowerCase();

    const hits = [];
    for (const t of tokens) {
      for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) {
        hits.push([i, i + t.length]);
      }
    }

    if (!hits.length) {
      parent.textContent = text;
      return;
    }

    // Overlapping tokens ("git" and "hub" in "github") must not produce
    // nested or duplicated spans, so merge the ranges first.
    hits.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of hits) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }

    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) parent.append(text.slice(pos, s));
      const m = document.createElementNS(HTML, "span");
      m.className = "match";
      m.textContent = text.slice(s, e);
      parent.append(m);
      pos = e;
    }
    if (pos < text.length) parent.append(text.slice(pos));
  }

  // Vimium's Suggestion.shortenUrl: decode and lowercase for display. Its
  // Google-specific query-param stripping is omitted — niche cleanup, and it
  // only ever applies to google.com result URLs.
  function shortenUrl(url) {
    try {
      return decodeURI(url).toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  // ------------------------------------------------------------ data ---

  function listTabs() {
    return gBrowser.tabs
      .filter((t) => !t.closing)
      .map((t) => ({
        label: t.label || "(untitled)",
        sub: t.linkedBrowser?.currentURI?.spec ?? "",
        source: "tab",
        pick: () => (gBrowser.selectedTab = t),
      }));
  }

  async function listBookmarks() {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT b.title AS title, p.url AS url
         FROM moz_bookmarks b
         JOIN moz_places p ON b.fk = p.id
        WHERE b.type = :type
        ORDER BY p.frecency DESC
        LIMIT 2000`,
      { type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
    );
    return rows.map((r) => ({
      label: r.getResultByName("title") || r.getResultByName("url"),
      sub: r.getResultByName("url"),
      url: r.getResultByName("url"),
      source: "bookmark",
    }));
  }

  // ---- Vimium's ranking, ported from background_scripts/completion/ranking.js
  // and the HistoryCompleter.computeRelevancy in completers.js. Frecency alone
  // ranked "World of Warcraft" (a title match) above warcraftlogs.com (a URL
  // match); this scores match quality per field instead.

  const MATCH_WEIGHTS = {
    matchAnywhere: 1,
    matchStartOfWord: 1,
    matchWholeWord: 1,
    maximumScore: 3, // sum of the three above, used to normalise
    recencyCalibrator: 2.0 / 3.0,
  };
  const ONE_MONTH_MS = 1000 * 60 * 60 * 24 * 30;

  const escapeRegex = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  // Smartcase: case-insensitive unless the term itself contains a capital.
  const regexFor = (term, prefix = "", suffix = "") =>
    new RegExp(prefix + escapeRegex(term) + suffix, /[A-Z]/.test(term) ? "" : "i");

  function scoreTerm(term, string) {
    let score = 0;
    let count = 0;
    const nonMatching = string.split(regexFor(term));
    if (nonMatching.length > 1) {
      score = MATCH_WEIGHTS.matchAnywhere;
      count = nonMatching.reduce((p, c) => p - c.length, string.length);
      if (regexFor(term, "\\b").test(string)) {
        score += MATCH_WEIGHTS.matchStartOfWord;
        if (regexFor(term, "\\b", "\\b").test(string)) {
          score += MATCH_WEIGHTS.matchWholeWord;
        }
      }
    }
    return [score, Math.min(count, string.length)];
  }

  function normalizeDifference(a, b) {
    const max = Math.max(a, b);
    return max === 0 ? 0 : (max - Math.abs(a - b)) / max;
  }

  function wordRelevancy(terms, url, title) {
    let urlScore = 0;
    let titleScore = 0;
    let urlCount = 0;
    let titleCount = 0;

    for (const term of terms) {
      let [s, c] = scoreTerm(term, url);
      urlScore += s;
      urlCount += c;
      if (title) {
        [s, c] = scoreTerm(term, title);
        titleScore += s;
        titleCount += c;
      }
    }

    const maximumPossibleScore = MATCH_WEIGHTS.maximumScore * terms.length;

    urlScore /= maximumPossibleScore;
    urlScore *= normalizeDifference(urlCount, url.length);

    if (title) {
      titleScore /= maximumPossibleScore;
      titleScore *= normalizeDifference(titleCount, title.length);
    } else {
      titleScore = urlScore;
    }

    // Don't let a poor urlScore drag down a good titleScore — a long URL
    // scores badly on length alone.
    if (urlScore < titleScore) urlScore = titleScore;

    return (urlScore + titleScore) / 2;
  }

  // Quadratic falloff; anything older than a month scores 0.
  function recencyScore(lastVisitMs) {
    if (!lastVisitMs) return 0;
    const recency = Date.now() - lastVisitMs;
    const d = Math.max(0, ONE_MONTH_MS - recency) / ONE_MONTH_MS;
    return d * d * d * MATCH_WEIGHTS.recencyCalibrator;
  }

  function computeRelevancy(terms, url, title, lastVisitMs) {
    const recency = recencyScore(lastVisitMs);
    if (!terms.length) return recency;
    const relevancy = wordRelevancy(terms, url, title);
    // Recency can pull a score up but never down.
    return (relevancy + Math.max(recency, relevancy)) / 2;
  }

  // Vimium's ranking.matches: every term must appear in the url or the title.
  // Applied after the SQL filter so smartcase is honoured.
  const matchesAllTerms = (terms, url, title) =>
    terms.every((t) => regexFor(t).test(url) || regexFor(t).test(title || ""));

  // `open` queries Places per keystroke; every other palette ranks a preloaded
  // list, and this is that half. No recency to feed in, so it is pure
  // wordRelevancy.
  const rankItems = (terms, list) => {
    if (!terms.length) return list;
    const scored = list
      .filter((it) => matchesAllTerms(terms, it.sub ?? "", it.label))
      .map((it) => [computeRelevancy(terms, it.sub ?? "", it.label, 0), it]);
    scored.sort((a, b) => b[0] - a[0]);
    return scored.map(([, it]) => it);
  };

  // Vimium's DomainCompleter. For a single-word query it contributes exactly
  // one suggestion — the best-matching domain — with a fixed relevancy of 2.0,
  // which outranks every history suggestion (those score in [0,1]). That fixed
  // score, not the ranking maths, is what puts raider.io above a page merely
  // titled "raid".
  const DOMAIN_RELEVANCY = 2.0;

  async function searchDomain(query) {
    // Single-word queries only — /\S\s/ in Vimium.
    if (!query || /\S\s/.test(query)) return null;
    const term = query.trim();
    if (!term) return null;

    const db = await PlacesUtils.promiseDBConnection();
    // moz_origins is already a domain table: prefix is "https://", host the
    // domain, so no grouping or URL parsing needed.
    const rows = await db.executeCached(
      `SELECT o.prefix || o.host AS domain,
              MAX(p.last_visit_date) AS lastVisit
         FROM moz_origins o
         JOIN moz_places p ON p.origin_id = o.id
        WHERE p.hidden = 0 AND LOWER(o.host) LIKE :q ESCAPE '\\'
        GROUP BY o.id
        ORDER BY o.frecency DESC
        LIMIT 100`,
      { q: `%${term.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%` }
    );

    const scored = rows
      .map((r) => {
        const domain = r.getResultByName("domain");
        const lastVisit = (r.getResultByName("lastVisit") ?? 0) / 1000;
        const relevancy = wordRelevancy([term], domain, null);
        return {
          domain,
          // Same combination the history completer uses.
          score: (relevancy + Math.max(recencyScore(lastVisit), relevancy)) / 2,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    const { domain } = scored[0];
    return {
      label: "", // no title line — the domain is the whole suggestion
      sub: domain,
      url: domain,
      source: "domain",
      score: DOMAIN_RELEVANCY,
    };
  }

  // History + bookmarks. SQL is only a coarse filter — frecency picks the
  // candidate pool, then Vimium's scoring decides the order.
  async function searchPlaces(query, limit = 40) {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((t) => t.replace(/[%_\\]/g, (c) => `\\${c}`));

    if (!tokens.length) return [];

    const where = tokens
      .map(
        (_, i) =>
          `(LOWER(p.url) LIKE :t${i} ESCAPE '\\' OR ` +
          `LOWER(IFNULL(p.title,'')) LIKE :t${i} ESCAPE '\\')`
      )
      .join(" AND ");

    // Pull a wide candidate pool: the best-scoring row is often not among the
    // top few by frecency, which is the whole reason the old ordering was
    // wrong. Ranking happens below, in JS.
    const params = { limit: Math.max(limit * 10, 300) };
    tokens.forEach((t, i) => (params[`t${i}`] = `%${t}%`));

    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT p.url AS url,
              IFNULL(NULLIF(b.title,''), IFNULL(NULLIF(p.title,''), p.url)) AS title,
              p.last_visit_date AS lastVisit,
              (b.id IS NOT NULL) AS bookmarked
         FROM moz_places p
         LEFT JOIN moz_bookmarks b ON b.fk = p.id AND b.type = :type
        WHERE p.hidden = 0 AND ${where}
        ORDER BY p.frecency DESC
        LIMIT :limit`,
      { ...params, type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
    );

    // Raw terms, not the LIKE-escaped ones — the regexes do their own escaping,
    // and smartcase needs the original capitalisation.
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 4);

    return rows
      .map((r) => {
        const url = r.getResultByName("url");
        const title = r.getResultByName("title");
        // moz_places stores microseconds.
        const lastVisit = (r.getResultByName("lastVisit") ?? 0) / 1000;
        return {
          label: title,
          sub: url,
          url,
          source: r.getResultByName("bookmarked") ? "bookmark" : "history",
          score: computeRelevancy(terms, url, title, lastVisit),
          _url: url,
          _title: title,
        };
      })
      .filter((it) => matchesAllTerms(terms, it._url, it._title))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function openInput(text, where) {
    const fixup = Services.uriFixup.getFixupURIInfo(
      text,
      Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS |
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP
    );
    const uri = fixup.preferredURI;
    if (!uri) return;
    win.openTrustedLinkIn(uri.spec, where === "tab" ? "tab" : "current");
  }

  // -------------------------------------------------------- command line ---
  // A chrome element, not an injected iframe. It therefore renders above every
  // page including about:*, survives fullscreen, and cannot be styled or
  // blocked by page CSS.

  const palette = (() => {
    // Vimium's own DOM shape, so its stylesheet applies unmodified:
    //   #vomnibar > #vomnibar-search-area > input
    //   #vomnibar > ul > li > .top-half/.bottom-half
    const bar = document.createElementNS(HTML, "div");
    bar.id = "vomnibar";
    bar.setAttribute("hidden", "true");

    const searchArea = document.createElementNS(HTML, "div");
    searchArea.id = "vomnibar-search-area";

    const input = document.createElementNS(HTML, "input");
    input.setAttribute("type", "text");

    const list = document.createElementNS(HTML, "ul");

    searchArea.append(input);
    bar.append(searchArea, list);

    // Loaded as a file rather than inlined, so it stays a verbatim copy.
    const style = document.createElementNS(HTML, "link");
    style.setAttribute("rel", "stylesheet");
    style.setAttribute("href", "resource://vimfox/vomnibar.css");

    // Overrides layered on top of the verbatim copy, so that file stays a
    // clean diff against upstream.
    const hideRule = document.createElementNS(HTML, "style");
    hideRule.textContent = `
      /* The copied CSS hard-sets display:block; Vimium destroys the element
         rather than hiding it, so it has no [hidden] rule of its own. */
      #vomnibar[hidden] { display: none; }

      /* Vimium's geometry comes from its host iframe (iframe.vomnibar-frame in
         content_scripts/vimium.css): top:70px, width:calc(80% + 20px),
         min-width:400px, centred via left:50%/margin-left:-40%, with the bar
         itself 8px down inside the frame — so 78px below the top of the
         CONTENT viewport.

         We are position:fixed inside browser.xhtml, where y=0 is the top of
         the window, above the tab strip and toolbars. So the real offset is
         measured from the content area at open() time; these are only
         fallbacks for before that runs. */
      #vomnibar {
        top: 78px;
        left: 50%;
        transform: translateX(-50%);
        width: 80%;
        min-width: 400px;
      }

      /* The iframe used to bound the list height; without it a long result
         set would run off the bottom of the screen. */
      #vomnibar ul { max-height: 60vh; overflow-y: auto; }
    `;

    document.documentElement.append(style, hideRule, bar);

    let items = [];
    let filtered = [];
    let sel = 0;
    let kind = "ex";
    let where = "current";
    let lookupToken = 0;
    let openToken = 0;
    // Vimium's initialSelectionValue: -1 for the omni completer, so nothing is
    // selected until you Tab and Enter uses exactly what you typed. The tab and
    // bookmark palettes have no meaningful "raw text" action, so they start at 0.
    let initialSel = -1;

    // Align to the content viewport, the way Vimium's iframe is. Measured on
    // every open so it survives toolbar changes, a sidebar, and fullscreen.
    function position() {
      const r = gBrowser.selectedBrowser?.getBoundingClientRect();
      if (!r?.width) return; // keep the CSS fallback

      bar.style.top = `${r.top + 78}px`;
      bar.style.left = `${r.left + r.width / 2}px`;
      bar.style.width = `${Math.max(r.width * 0.8, 400)}px`;
      bar.style.maxHeight = `${Math.max(r.height - 88, 200)}px`;
    }

    function render() {
      list.textContent = "";
      // The copied `#vomnibar ul { display: none }` means the list only shows
      // when we say so — same as Vimium, whose JS drives this too.
      list.style.display = filtered.length ? "block" : "none";

      const tokens = input.value
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      filtered.slice(0, 200).forEach((it, i) => {
        const el = document.createElementNS(HTML, "li");
        if (i === sel) {
          el.className = "selected";
          // The list scrolls now, so keep the selection visible.
          win.requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
        }

        // Vimium's layout (Suggestion.generateHtml):
        //   top-half:    <span.source>type</span><span.title>title</span>
        //   bottom-half: <span.url>url</span>
        // The type belongs beside the TITLE, not beside the URL.
        const top = document.createElementNS(HTML, "div");
        top.className = "top-half";

        const src = document.createElementNS(HTML, "span");
        src.className = "source";
        src.textContent = it.source ?? "";
        top.append(src);

        const title = document.createElementNS(HTML, "span");
        title.className = "title";
        highlight(title, it.label ?? "", tokens);
        top.append(title);

        const bottom = document.createElementNS(HTML, "div");
        bottom.className = "bottom-half";
        const url = document.createElementNS(HTML, "span");
        url.className = "url";
        highlight(url, shortenUrl(it.sub ?? ""), tokens);
        bottom.append(url);

        el.append(top, bottom);
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          sel = i;
          accept();
        });
        list.append(el);
      });
    }

    function filter() {
      // `open` queries Places on each keystroke rather than filtering a
      // preloaded list — the history table is far too big to hold in memory.
      if (kind === "open") {
        lookup();
        return;
      }

      // One substring could never match "goto kys" against
      // goto.netcompany.com/…/kys. render() already tokenised for highlighting.
      filtered = rankItems(
        input.value.trim().split(/\s+/).filter(Boolean).slice(0, 4),
        items
      );
      sel = initialSel;
      render();
    }

    // Vimium's mechanism exactly (pages/vomnibar_page.js updateCompletions):
    // fire on every keystroke with no debounce, do NOT touch the DOM on the
    // way in, and render once — when results arrive. The previous list stays
    // on screen until it is replaced in a single write, so there is never an
    // empty frame. Stale replies are dropped by request id, as Vimium does
    // with lastRequestId.
    async function lookup() {
      const token = ++lookupToken;
      const text = input.value.trim();

      if (!text) {
        filtered = [];
        sel = initialSel;
        render();
        return;
      }

      let rows = [];
      try {
        // Both completers run against the same query, as Vimium does, and are
        // merged by score — the domain's fixed 2.0 always lands it first.
        const [domain, places] = await Promise.all([
          searchDomain(text),
          searchPlaces(text),
        ]);
        rows = domain
          ? [domain, ...places.filter((p) => p.url !== domain.url)]
          : places;
      } catch (ex) {
        log(`lookup failed: ${ex}`);
      }
      if (token !== lookupToken || kind !== "open") return;

      filtered = rows;
      sel = initialSel;
      render();
    }

    // Vimium's wrapping: past the end returns to initialSel (for `open`, that
    // is "nothing selected"), and stepping back from there lands on the last
    // row rather than being clamped.
    function move(dir) {
      if (!filtered.length) return;
      sel += dir;
      if (sel >= filtered.length) sel = initialSel;
      else if (sel < initialSel) sel = filtered.length - 1;
      render();
    }

    function close() {
      bar.setAttribute("hidden", "true");
      input.value = "";
      items = filtered = [];
      list.textContent = "";
      setMode("normal");
      gBrowser.selectedBrowser.focus();
    }

    function accept() {
      const text = input.value.trim();
      const choice = filtered[sel];

      if (kind === "tab" && choice) {
        choice.pick();
      } else if (kind === "bookmark" && choice) {
        win.openTrustedLinkIn(choice.url, where === "tab" ? "tab" : "current");
      } else if (kind === "open") {
        // Nothing selected (sel === -1) means use exactly what was typed.
        if (choice?.url) {
          win.openTrustedLinkIn(choice.url, where === "tab" ? "tab" : "current");
        } else if (text) {
          openInput(text, where);
        }
      } else if (kind === "ex") {
        if (choice) {
          // Picking a command that needs an argument completes the line rather
          // than running it — selecting `open` should let you type the URL, not
          // open the empty string.
          if (choice.arg) {
            input.value = `${choice.name} `;
            filter();
            return;
          }
          runEx(choice.name);
        } else if (text) {
          runEx(text);
        }
      }
      close();
    }

    input.addEventListener("keydown", (e) => {
      // Tab must move the selection, not hand focus to the next XUL widget.
      // stopPropagation as well as preventDefault: XUL focus traversal runs
      // ahead of the default action, so preventDefault alone does not hold it.
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        move(e.shiftKey ? -1 : 1);
        return;
      }

      // Ctrl+U clears the command line. Handled here rather than as a binding
      // so it is scoped to the palette and nothing else.
      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        e.stopPropagation();
        deleteLineIn(input);
        return;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "Enter":
          e.preventDefault();
          accept();
          break;
        case "n":
          if (!e.ctrlKey) return;
        // fallthrough
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "p":
          if (!e.ctrlKey) return;
        // fallthrough
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
      }
    });

    input.addEventListener("input", filter);

    // Chrome popups — the translations panel is the usual culprit, but the
    // permission and password prompts do it too — grab focus while the bar is
    // open. Take it back. Vimium does the same in vomnibar_page.js.
    // Deferred so the stealing widget has finished focusing before we undo it,
    // and re-checked so closing the bar (which hides it first) doesn't loop.
    input.addEventListener("blur", () => {
      if (bar.hasAttribute("hidden")) return;
      win.setTimeout(() => {
        if (!bar.hasAttribute("hidden") && vf.mode === "command") input.focus();
      }, 0);
    });

    return {
      async open(k, source, dest, prefill) {
        // Same guard lookup() has. Without it, opening `b` (a Places query that
        // can take a while cold), closing it, and opening `gt` before it
        // resolves let the bookmark results land in the tab palette — where
        // accept() calls choice.pick() on an object that has no pick.
        const token = ++openToken;
        kind = k;
        where = dest ?? "current";
        initialSel = k === "open" || k === "ex" ? -1 : 0;
        sel = initialSel;
        setMode("command");
        // Vimium has no sigil element, so the hint goes in the placeholder.
        input.setAttribute(
          "placeholder",
          k === "ex" ? ":" : k === "open" ? (dest === "tab" ? "tabopen" : "open") : k
        );
        position();
        bar.removeAttribute("hidden");
        items = filtered = [];
        render();
        input.value = prefill ?? "";
        input.focus();
        // Cursor at the end, not selecting the text — ge is for editing the
        // URL, so a stray keystroke must not wipe it.
        input.setSelectionRange(input.value.length, input.value.length);

        if (source) {
          const rows = typeof source.then === "function" ? await source : source;
          if (token !== openToken) return;
          items = rows;
          filter();
        } else if (input.value) {
          filter(); // ge prefills a URL; show matches for it straight away
        }
      },
      close,
      destroy() {
        bar.remove();
        style.remove();
        hideRule.remove();
      },
    };
  })();

  return {
    palette,
    // Defined here because the palette is its only real caller; the ex table
    // in window.js reaches back for it.
    openInput,
    listTabs,
    listBookmarks,
    // Exported for the self-test; these are pure and worth checking.
    highlight,
    computeRelevancy,
    matchesAllTerms,
    rankItems,
    DOMAIN_RELEVANCY,
    ONE_MONTH_MS,
  };
};
