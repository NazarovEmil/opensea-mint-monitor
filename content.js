(() => {
  if (window.__OSMM_LOADED__) return;
  window.__OSMM_LOADED__ = true;

  const LOG_PREFIX = "[OSMM]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);

  log("loaded", location.href);

  // ==================== CONFIG ====================
  // All timings are in milliseconds unless noted otherwise.
  const CONFIG = {
    // Full DOM scan cadence. Fast enough to catch new mints, cheap for the CPU.
    scanIntervalMs: 1500,

    // "Hot right now" window used only for the row outline and one metric on the card.
    hotWindowMs: 60 * 1000,

    // A collection is treated as brand-new for 60 seconds after we first saw it.
    // During this time it gets a blue border, a "NEW" badge and a short pulse.
    freshDurationMs: 60 * 1000,

    // Defaults for user-facing filters.
    defaultWindowMinutes: 60,
    defaultMinMints: 1,

    // LocalStorage keys. Bumped when the schema changes.
    positionStorageKey: "osmm-panel-pos-v1",
    stateStorageKey: "osmm-state-v4",
    settingsStorageKey: "osmm-settings-v3",
    seenStorageKey: "osmm-seen-v1",

    // Flush state to localStorage every 5s so a refresh does not lose data.
    stateSaveIntervalMs: 5000,

    // Hard bounds for retention so the user cannot fill localStorage.
    minRetentionMs: 60 * 1000,
    maxRetentionMs: 24 * 60 * 60 * 1000,

    // We keep the "seen" flag for a collection for a week, then forget it.
    // If a collection you opened a week ago starts minting again, it should
    // reappear as new — that is almost certainly a different drop anyway.
    seenRetentionMs: 7 * 24 * 60 * 60 * 1000,

    // OpenSea GraphQL endpoint that powers the collection tooltip on hover.
    graphqlUrl: "https://gql.opensea.io/graphql",
    tooltipQueryName: "CollectionPreviewTooltipContentQuery",
    tooltipQueryHash: "761282bbf059601b6b02e7c6061a4be4f7958d28a3b386a1305295d9b1d2fd81",

    // Rate limits for the stats fetcher.
    fetchGapMs: 400,
    statsRefreshMs: 2 * 60 * 1000,
    statsFailRetryMs: 30 * 1000,

    // Safety cap on stored events per collection.
    maxEventsPerCollection: 2000
  };

  // Known chain names — used to tag rows even when OpenSea only shows an icon.
  const CHAIN_HINTS = [
    { name: "Robinhood", regex: /\brobinhood\b|\brbh\b|\brh chain\b/i },
    { name: "Ethereum", regex: /\bethereum\b|\bmainnet\b/i },
    { name: "Base", regex: /\bbase\b/i },
    { name: "Polygon", regex: /\bpolygon\b|\bmatic\b|\bpol\b/i },
    { name: "Arbitrum", regex: /\barbitrum\b|\barb\b/i },
    { name: "Optimism", regex: /\boptimism\b|\bop mainnet\b/i },
    { name: "Avalanche", regex: /\bavalanche\b|\bavax\b/i },
    { name: "Solana", regex: /\bsolana\b/i },
    { name: "BNB Chain", regex: /\bbnb\b/i },
    { name: "Blast", regex: /\bblast\b/i },
    { name: "Zora", regex: /\bzora\b/i },
    { name: "ApeChain", regex: /\bape ?chain\b/i },
    { name: "Ronin", regex: /\bronin\b/i }
  ];

  const state = {
    paused: false,
    panel: null,
    listEl: null,
    summaryEl: null,
    statusEl: null,
    debugEl: null,
    headerEl: null,
    observer: null,
    scanTimerId: 0,
    routeTimerId: 0,
    saveTimerId: 0,
    routeKey: "",
    lastScanAt: 0,
    lastRowsFound: 0,
    lastMintRowsFound: 0,
    settings: {
      windowMinutes: CONFIG.defaultWindowMinutes,
      minMints: CONFIG.defaultMinMints,
      dimRepeats: true,
      onlyWithOffer: false,
      onlyOfferAboveMint: false,
      seenCollapsed: false
    },
    // Source of truth for collections and events. Independent from DOM.
    eventSeen: new Map(),
    collections: new Map(),
    // Stats from GraphQL: slug → { data, loading, ok, fetchedAt }.
    stats: new Map(),
    // Slugs the user has opened by clicking "open collection".
    // Persisted separately so it survives cache clears of the main state.
    seen: new Map(),
    // Collections we already animated with the pulse.
    // Kept in memory only — pulse should replay on page refresh, that is intentional.
    pulsed: new Set(),
    fetchQueue: [],
    fetching: false,
    dirty: false,
    drag: { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 }
  };

  let scanScheduled = false;

  // ==================== UTILS ====================

  function normalizeText(text) {
    if (text === undefined || text === null) return "";
    return String(text).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(text) {
    return String(text === undefined || text === null ? "" : text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function canonicalUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return `${u.origin}${u.pathname}`;
    } catch { return url || ""; }
  }

  function pathFromUrl(url) {
    try { return new URL(url, location.origin).pathname.toLowerCase(); }
    catch { return ""; }
  }

  function isItemLink(url) { return /\/(assets|asset|item|items|nft)\//i.test(pathFromUrl(url)); }
  function isCollectionLink(url) { return /\/collection\//i.test(pathFromUrl(url)); }

  function slugFromCollectionUrl(url) {
    const m = pathFromUrl(url).match(/\/collection\/([^\/]+)/i);
    return m ? m[1] : null;
  }

  function extractRelativeTimestamp(text) {
    const now = Date.now();
    const t = normalizeText(text).toLowerCase();
    if (!t) return now;
    if (/\bjust now\b/.test(t)) return now;
    let m = t.match(/(\d+)\s*(s|sec|secs|second|seconds)\s*(ago)?/);
    if (m) return now - Number(m[1]) * 1000;
    m = t.match(/(\d+)\s*(m|min|mins|minute|minutes)\s*(ago)?/);
    if (m) return now - Number(m[1]) * 60 * 1000;
    m = t.match(/(\d+)\s*(h|hr|hrs|hour|hours)\s*(ago)?/);
    if (m) return now - Number(m[1]) * 60 * 60 * 1000;
    m = t.match(/(\d+)\s*(d|day|days)\s*(ago)?/);
    if (m) return now - Number(m[1]) * 24 * 60 * 60 * 1000;
    return now;
  }

  function extractPrice(text) {
    // USDG included for Robinhood Chain.
    const m = normalizeText(text).match(/(\d+(?:[.,]\d+)?)\s*(ETH|WETH|POL|MATIC|ARB|OP|AVAX|SOL|RBH|RH|BNB|USDC|USDT|USDG)\b/i);
    if (!m) return null;
    return {
      amount: Number(m[1].replace(",", ".")),
      unit: m[2].toUpperCase(),
      raw: `${m[1]} ${m[2].toUpperCase()}`
    };
  }

  function collectAccessibleText(root) {
    const chunks = [];
    root.querySelectorAll("[aria-label], [alt], [title]").forEach((el) => {
      const v = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
      if (v) chunks.push(v);
    });
    root.querySelectorAll("img[src]").forEach((el) => {
      const v = el.getAttribute("src") || "";
      if (v) chunks.push(v);
    });
    return normalizeText(chunks.join(" "));
  }

  function detectChain(fullText, row) {
    const accessible = collectAccessibleText(row);
    for (const chain of CHAIN_HINTS) if (chain.regex.test(accessible)) return chain.name;
    for (const chain of CHAIN_HINTS) if (chain.regex.test(fullText)) return chain.name;
    return "Unknown";
  }

  function slugifySoft(text) {
    return normalizeText(text).toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "").slice(0, 120);
  }

  function looksLikeMintRow(text) { return /\bmint\b/i.test(text); }

  function getRetentionMs() {
    const requested = state.settings.windowMinutes * 60 * 1000;
    return Math.max(CONFIG.minRetentionMs, Math.min(CONFIG.maxRetentionMs, requested));
  }

  // ==================== ROW EXTRACTION ====================

  function collectRowCandidates() {
    const set = new Set();

    // Real <tr> elements.
    document.querySelectorAll('tr[role="row"], tr').forEach((el) => {
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
      // Require ≥3 cells to skip header/summary rows.
      if (cells.length >= 3) set.add(el);
    });

    // ARIA row containers.
    document.querySelectorAll('[role="row"]').forEach((el) => {
      if (el.tagName === "TR") return;
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('[role="cell"], [role="gridcell"]');
      if (cells.length >= 3) set.add(el);
    });

    // Fallback: walk up from item/collection anchors.
    const main = document.querySelector("main") || document.body;
    main.querySelectorAll("a[href]").forEach((anchor) => {
      if (!isItemLink(anchor.href) && !isCollectionLink(anchor.href)) return;
      let el = anchor;
      // 10 levels max — deeper is almost certainly noise.
      for (let depth = 0; depth < 10 && el; depth += 1, el = el.parentElement) {
        if (!el) break;
        if (el.id === "osmm-panel") return;
        if (el.closest && el.closest("#osmm-panel")) return;
        const text = normalizeText(el.innerText || "");
        if (!text || !looksLikeMintRow(text)) continue;
        // 10..2000 chars: shorter is a badge, longer is the whole feed container.
        if (text.length < 10 || text.length > 2000) continue;
        set.add(el);
        break;
      }
    });

    return [...set];
  }

  function pickItemCell(row) {
    const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')];
    for (const c of cells) {
      if (c.querySelector('a[href*="/collection/"], a[href*="/assets/"], a[href*="/asset/"], a[href*="/item/"], a[href*="/items/"], a[href*="/nft/"]')) {
        return c;
      }
    }
    return null;
  }

  function extractCollectionInfoFromRow(row) {
    const cell = pickItemCell(row);
    const search = cell || row;

    const anchors = [...search.querySelectorAll("a[href]")];
    const collectionAnchor = anchors.find((a) => isCollectionLink(a.href));
    const itemAnchor = anchors.find((a) => isItemLink(a.href));

    // Leaf-node texts in the item cell: usually "#853" then "Hoodboyzz".
    const leafTexts = [];
    search.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = normalizeText(el.textContent || "");
        // 2..120 chars filters empty spans and giant paragraphs.
        if (t && t.length >= 2 && t.length <= 120) leafTexts.push(t);
      }
    });

    const title = leafTexts[0] || null;
    const subtitle = leafTexts[1] || null;

    let collectionName = null;
    let collectionUrl = null;

    if (collectionAnchor) {
      collectionUrl = canonicalUrl(collectionAnchor.href);
      const anchorText = normalizeText(collectionAnchor.textContent);
      if (anchorText) collectionName = anchorText;
    }

    if (!collectionName) {
      // Skip token-id subtitles like "#123".
      if (subtitle && !/^#\d+/.test(subtitle)) collectionName = subtitle;
      else collectionName = title;
    }

    if (!collectionName) collectionName = "Unknown";

    return {
      name: collectionName, title, subtitle, url: collectionUrl,
      itemUrl: itemAnchor ? canonicalUrl(itemAnchor.href) : null
    };
  }

  function extractPriceFromRow(row) {
    const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')];
    for (const c of cells) {
      const p = extractPrice(c.innerText || "");
      if (p) return p;
    }
    return extractPrice(row.innerText || "");
  }

  function extractTimeFromRow(row) {
    const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')];
    // Scan from the last cell backwards — "TIME" is usually rightmost.
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const t = normalizeText(cells[i].innerText || "");
      if (/(\bjust now\b|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*(ago)?)/i.test(t)) {
        return extractRelativeTimestamp(t);
      }
    }
    return extractRelativeTimestamp(row.innerText || "");
  }

  function extractEventMeta(row) {
    const rowText = normalizeText(row.innerText || "");
    if (!rowText || !looksLikeMintRow(rowText)) return null;

    const info = extractCollectionInfoFromRow(row);
    if (!info) return null;

    const chain = detectChain(rowText, row);
    const price = extractPriceFromRow(row);
    const seenAt = extractTimeFromRow(row);
    const slug = info.url ? slugFromCollectionUrl(info.url) : null;

    const collectionKeyBase = slug || slugifySoft(info.name || "unknown");
    const collectionKey = `${chain.toLowerCase()}::${collectionKeyBase}`;

    // Bucket time into 30-second slots so "3m ago" → "4m ago" transitions
    // do not create phantom duplicate events for the same physical mint.
    const itemUrl = info.itemUrl || "";
    const timeBucket = Math.round(seenAt / 30000);
    const eventKey = `${collectionKey}|${itemUrl}|${timeBucket}`;

    return {
      eventKey, collectionKey, slug,
      name: info.name || "Unknown",
      chain, collectionUrl: info.url,
      itemUrl: info.itemUrl,
      price, seenAt
    };
  }

  // ==================== STORAGE MODEL ====================

  function addEvent(meta) {
    let col = state.collections.get(meta.collectionKey);
    const isFirstTimeSeen = !col;
    if (!col) {
      col = {
        key: meta.collectionKey, slug: meta.slug,
        name: meta.name, chain: meta.chain,
        collectionUrl: meta.collectionUrl, itemUrl: meta.itemUrl,
        firstSeen: meta.seenAt, lastSeen: meta.seenAt,
        // discoveredAt is when the extension first noticed this collection,
        // independent from the mint timestamp. Used for NEW badge / pulse.
        discoveredAt: Date.now(),
        lastPrice: meta.price, events: []
      };
      state.collections.set(meta.collectionKey, col);
    }

    col.name = meta.name || col.name;
    col.chain = meta.chain || col.chain;
    col.collectionUrl = meta.collectionUrl || col.collectionUrl;
    col.itemUrl = meta.itemUrl || col.itemUrl;
    col.slug = col.slug || meta.slug;
    col.lastSeen = Math.max(col.lastSeen, meta.seenAt);
    col.firstSeen = Math.min(col.firstSeen, meta.seenAt);
    if (meta.price) col.lastPrice = meta.price;

    col.events.push({ ts: meta.seenAt, price: meta.price });

    if (col.events.length > CONFIG.maxEventsPerCollection) {
      col.events.splice(0, col.events.length - CONFIG.maxEventsPerCollection);
    }

    state.dirty = true;
    if (col.slug) enqueueStatsFetch(col.slug);
    return isFirstTimeSeen;
  }

  function pruneByRetention() {
    const now = Date.now();
    const retention = getRetentionMs();
    const cutoff = now - retention;

    for (const [k, ts] of state.eventSeen.entries()) {
      if (ts < cutoff) state.eventSeen.delete(k);
    }

    for (const [k, col] of state.collections.entries()) {
      col.events = col.events.filter((e) => e.ts >= cutoff);
      if (!col.events.length) {
        state.collections.delete(k);
        state.dirty = true;
      } else {
        col.lastSeen = col.events[col.events.length - 1].ts;
        col.firstSeen = col.events[0].ts;
      }
    }

    // Forget stale "seen" flags so ancient collections don't clog storage.
    const seenCutoff = now - CONFIG.seenRetentionMs;
    for (const [k, ts] of state.seen.entries()) {
      if (ts < seenCutoff) state.seen.delete(k);
    }
  }

  function getMetrics(col, now) {
    const t = now || Date.now();
    const hotCutoff = t - CONFIG.hotWindowMs;
    let hotCount = 0;
    for (const e of col.events) {
      if (e.ts >= hotCutoff) hotCount += 1;
    }
    return { hotCount, total: col.events.length };
  }

  // ==================== PERSISTENCE ====================

  function saveSettings() {
    try { localStorage.setItem(CONFIG.settingsStorageKey, JSON.stringify(state.settings)); } catch (e) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(CONFIG.settingsStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") Object.assign(state.settings, parsed);
    } catch (e) {}
  }

  function saveSeen() {
    try { localStorage.setItem(CONFIG.seenStorageKey, JSON.stringify([...state.seen.entries()])); } catch (e) {}
  }

  function loadSeen() {
    try {
      const raw = localStorage.getItem(CONFIG.seenStorageKey);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      const cutoff = Date.now() - CONFIG.seenRetentionMs;
      arr.forEach(([k, ts]) => {
        if (typeof k === "string" && typeof ts === "number" && ts >= cutoff) state.seen.set(k, ts);
      });
    } catch (e) {}
  }

  function flushState() {
    if (!state.dirty) return;
    state.dirty = false;
    try {
      const payload = {
        savedAt: Date.now(),
        collections: [...state.collections.values()].map((c) => ({
          key: c.key, slug: c.slug, name: c.name, chain: c.chain,
          collectionUrl: c.collectionUrl, itemUrl: c.itemUrl,
          firstSeen: c.firstSeen, lastSeen: c.lastSeen,
          discoveredAt: c.discoveredAt,
          lastPrice: c.lastPrice, events: c.events
        })),
        eventSeen: [...state.eventSeen.entries()]
      };
      localStorage.setItem(CONFIG.stateStorageKey, JSON.stringify(payload));
    } catch (e) {
      log("state save failed", e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(CONFIG.stateStorageKey);
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.collections)) return;

      const cutoff = Date.now() - getRetentionMs();

      payload.collections.forEach((c) => {
        const events = (c.events || []).filter((e) => e && e.ts >= cutoff);
        if (!events.length) return;
        state.collections.set(c.key, {
          key: c.key, slug: c.slug || null,
          name: c.name || "Unknown", chain: c.chain || "Unknown",
          collectionUrl: c.collectionUrl || null,
          itemUrl: c.itemUrl || null,
          firstSeen: events[0].ts, lastSeen: events[events.length - 1].ts,
          // discoveredAt from a previous session is preserved so restored
          // cards do not falsely show as "NEW" after a refresh.
          discoveredAt: c.discoveredAt || events[0].ts,
          lastPrice: c.lastPrice || null,
          events
        });
      });

      if (Array.isArray(payload.eventSeen)) {
        payload.eventSeen.forEach(([k, ts]) => {
          if (typeof ts === "number" && ts >= cutoff) state.eventSeen.set(k, ts);
        });
      }

      log("state restored:", "collections=" + state.collections.size, "events=" + state.eventSeen.size);
    } catch (e) {
      log("state load failed", e);
    }
  }

  // ==================== STATS FETCH ====================

  function enqueueStatsFetch(slug) {
    if (!slug) return;
    const existing = state.stats.get(slug);
    const now = Date.now();

    if (existing) {
      const age = now - (existing.fetchedAt || 0);
      if (existing.loading) return;
      if (existing.ok && age < CONFIG.statsRefreshMs) return;
      if (!existing.ok && age < CONFIG.statsFailRetryMs) return;
    } else {
      state.stats.set(slug, { loading: true, ok: false, fetchedAt: 0 });
    }

    if (!state.fetchQueue.includes(slug)) state.fetchQueue.push(slug);
    runFetchQueue();
  }

  async function runFetchQueue() {
    if (state.fetching) return;
    state.fetching = true;

    while (state.fetchQueue.length) {
      const slug = state.fetchQueue.shift();
      try {
        const record = state.stats.get(slug) || {};
        record.loading = true;
        state.stats.set(slug, record);

        const raw = await fetchCollectionStats(slug);
        const parsed = parseCollectionStats(raw);

        state.stats.set(slug, { loading: false, ok: true, fetchedAt: Date.now(), data: parsed });
        renderPanel();
      } catch (err) {
        console.warn(LOG_PREFIX, "stats fetch failed for", slug, err);
        state.stats.set(slug, { loading: false, ok: false, fetchedAt: Date.now(), error: String(err && err.message || err) });
      }
      // Rate-limit gap between requests.
      await new Promise((r) => setTimeout(r, CONFIG.fetchGapMs));
    }

    state.fetching = false;
  }

  async function fetchCollectionStats(slug) {
    const url = new URL(CONFIG.graphqlUrl);
    url.searchParams.set("operationName", CONFIG.tooltipQueryName);
    url.searchParams.set("variables", JSON.stringify({ collectionSlug: slug }));
    url.searchParams.set("extensions", JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: CONFIG.tooltipQueryHash }
    }));

    const res = await fetch(url.toString(), {
      // credentials: "include" reuses the user's OpenSea session cookies.
      method: "GET", credentials: "include",
      headers: { accept: "application/json" }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function parsePriceObj(obj) {
    // OpenSea wraps prices in several shapes depending on context.
    if (!obj) return null;
    if (typeof obj.unit === "number") return { unit: obj.unit, symbol: obj.symbol || "" };
    if (obj.token && typeof obj.token.unit === "number") return { unit: obj.token.unit, symbol: obj.token.symbol || "" };
    if (obj.native && typeof obj.native.unit === "number") return { unit: obj.native.unit, symbol: obj.native.symbol || "" };
    if (obj.pricePerItem && obj.pricePerItem.token && typeof obj.pricePerItem.token.unit === "number") {
      return { unit: obj.pricePerItem.token.unit, symbol: obj.pricePerItem.token.symbol || "" };
    }
    return null;
  }

  function parseCollectionStats(raw) {
    const c = raw && raw.data && raw.data.collectionBySlug;
    if (!c) return null;

    const floor = parsePriceObj(c.floorPrice);
    const topOffer = parsePriceObj(c.topOffer);

    let mintPrice = null;
    if (c.drop && c.drop.activeDropStage && c.drop.activeDropStage.price) {
      mintPrice = parsePriceObj(c.drop.activeDropStage.price);
    }

    const stats = c.stats || {};
    const oneDayVolume = stats.oneDay && stats.oneDay.volume && stats.oneDay.volume.native;

    return {
      name: c.name || null,
      isVerified: !!c.isVerified,
      chainName: c.chain && c.chain.name || null,
      chainId: c.chain && c.chain.identifier || null,
      floor, topOffer, mintPrice,
      isMinting: !!(c.drop && c.drop.isMinting),
      maxSupply: c.drop && c.drop.maxSupply || null,
      totalSupply: stats.totalSupply || null,
      ownerCount: stats.ownerCount || null,
      listedCount: stats.listedItemCount || null,
      volume24h: oneDayVolume ? { unit: oneDayVolume.unit, symbol: oneDayVolume.symbol } : null
    };
  }

  function getEffectiveMintPrice(col, stats) {
    if (stats && stats.mintPrice && typeof stats.mintPrice.unit === "number") return stats.mintPrice.unit;
    if (col.lastPrice && typeof col.lastPrice.amount === "number") return col.lastPrice.amount;
    return null;
  }

  // ==================== FORMATTING ====================

  function formatAgo(ts, now) {
    const t = now || Date.now();
    const diff = Math.max(0, t - ts);
    const s = Math.floor(diff / 1000);
    if (s < 5) return "now";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function formatPrice(price) {
    if (!price) return "—";
    if (typeof price === "object" && "unit" in price) return `${price.unit} ${price.symbol || ""}`.trim();
    return price.raw || `${price.amount} ${price.unit}`;
  }

  function formatUnit(unit, symbol) {
    if (unit === undefined || unit === null) return "—";
    return `${unit} ${symbol || ""}`.trim();
  }

  // ==================== POSITION / DRAG ====================

  function loadSavedPosition() {
    try {
      const raw = localStorage.getItem(CONFIG.positionStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.left === "number" && typeof parsed.top === "number") return parsed;
    } catch (e) {}
    return null;
  }

  function savePosition(left, top) {
    try { localStorage.setItem(CONFIG.positionStorageKey, JSON.stringify({ left, top })); } catch (e) {}
  }

  function applyPosition(left, top) {
    if (!state.panel) return;
    // Keep the panel on-screen: at least 100px on the right, 40px on the bottom.
    const maxLeft = Math.max(0, window.innerWidth - 100);
    const maxTop = Math.max(0, window.innerHeight - 40);
    const safeLeft = Math.min(Math.max(0, left), maxLeft);
    const safeTop = Math.min(Math.max(0, top), maxTop);
    state.panel.style.left = `${safeLeft}px`;
    state.panel.style.top = `${safeTop}px`;
    state.panel.style.right = "auto";
    state.panel.style.bottom = "auto";
  }

  function snapTopRight() {
    if (!state.panel) return;
    const width = state.panel.offsetWidth || 380;
    // 14px inset matches OpenSea's own UI padding.
    const left = Math.max(0, window.innerWidth - width - 14);
    applyPosition(left, 14);
    savePosition(left, 14);
  }

  function onDragStart(e) {
    if (!state.panel) return;
    if (e.target.closest("[data-action], input, a, .osmm-body")) return;
    e.preventDefault();
    const rect = state.panel.getBoundingClientRect();
    state.drag.active = true;
    state.drag.startX = e.clientX;
    state.drag.startY = e.clientY;
    state.drag.startLeft = rect.left;
    state.drag.startTop = rect.top;
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragEnd, true);
  }

  function onDragMove(e) {
    if (!state.drag.active) return;
    applyPosition(state.drag.startLeft + (e.clientX - state.drag.startX),
                  state.drag.startTop + (e.clientY - state.drag.startY));
  }

  function onDragEnd() {
    if (!state.drag.active) return;
    state.drag.active = false;
    const rect = state.panel.getBoundingClientRect();
    savePosition(rect.left, rect.top);
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
  }

  // ==================== PANEL ====================

  function createPanel() {
    if (state.panel && document.documentElement.contains(state.panel)) return;

    const panel = document.createElement("div");
    panel.id = "osmm-panel";
    panel.innerHTML = `
      <div class="osmm-header" data-role="drag-handle">
        <div>
          <div class="osmm-title">OpenSea Mint Monitor</div>
          <div class="osmm-subtitle">drag me · persistent history</div>
        </div>
        <div class="osmm-header-actions">
          <button class="osmm-btn osmm-btn-small" data-action="snap" type="button" title="Snap to top-right">⇱</button>
          <button class="osmm-btn osmm-btn-small" data-action="minimize" type="button" title="Minimize">–</button>
        </div>
      </div>
      <div class="osmm-body">
        <div class="osmm-controls">
          <button class="osmm-btn" data-action="pause" type="button">Pause</button>
          <button class="osmm-btn" data-action="clear" type="button">Clear</button>
          <label class="osmm-check">
            <input type="checkbox" data-setting="dimRepeats" ${state.settings.dimRepeats ? "checked" : ""} />
            dim repeats
          </label>
        </div>
        <div class="osmm-controls osmm-controls-compact">
          <label title="How many minutes of history to keep and display">
            window
            <input type="number" min="1" max="1440" step="1" data-setting="windowMinutes" value="${state.settings.windowMinutes}" />
            min
          </label>
          <label title="Show a collection only if it had at least this many mints inside the window">
            min mints
            <input type="number" min="1" max="9999" step="1" data-setting="minMints" value="${state.settings.minMints}" />
          </label>
        </div>
        <div class="osmm-controls osmm-controls-compact">
          <label class="osmm-check" title="Show only collections that have at least one offer of any size">
            <input type="checkbox" data-setting="onlyWithOffer" ${state.settings.onlyWithOffer ? "checked" : ""} />
            has any offer
          </label>
          <label class="osmm-check" title="Show only collections where the top offer is above the mint price">
            <input type="checkbox" data-setting="onlyOfferAboveMint" ${state.settings.onlyOfferAboveMint ? "checked" : ""} />
            offer > mint
          </label>
        </div>
        <div class="osmm-summary"></div>
        <div class="osmm-status"></div>
        <div class="osmm-summary" data-role="debug" style="color:#ffbf69"></div>
        <div class="osmm-list"></div>
      </div>
    `;

    (document.documentElement || document.body).appendChild(panel);

    state.panel = panel;
    state.headerEl = panel.querySelector('[data-role="drag-handle"]');
    state.listEl = panel.querySelector(".osmm-list");
    state.summaryEl = panel.querySelector(".osmm-summary:not([data-role='debug'])");
    state.statusEl = panel.querySelector(".osmm-status");
    state.debugEl = panel.querySelector('[data-role="debug"]');

    const saved = loadSavedPosition();
    if (saved) applyPosition(saved.left, saved.top); else snapTopRight();

    state.headerEl.addEventListener("mousedown", onDragStart);

    panel.addEventListener("click", (e) => {
      // Clicks on "open collection" mark the collection as seen.
      const openLink = e.target.closest("a[data-role='open-collection']");
      if (openLink) {
        const key = openLink.dataset.collectionKey;
        if (key) {
          state.seen.set(key, Date.now());
          saveSeen();
          // Re-render to move the card into the SEEN section.
          renderPanel();
        }
        return;
      }

      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "pause") {
        state.paused = !state.paused;
        btn.textContent = state.paused ? "Resume" : "Pause";
        renderPanel();
        return;
      }
      if (action === "clear") {
        state.eventSeen.clear();
        state.collections.clear();
        state.pulsed.clear();
        state.dirty = true;
        flushState();
        renderPanel();
        annotateVisibleRows();
        return;
      }
      if (action === "minimize") {
        panel.classList.toggle("osmm-minimized");
        btn.textContent = panel.classList.contains("osmm-minimized") ? "+" : "–";
        return;
      }
      if (action === "snap") { snapTopRight(); return; }
      if (action === "toggle-seen") {
        state.settings.seenCollapsed = !state.settings.seenCollapsed;
        saveSettings();
        renderPanel();
        return;
      }
    });

    panel.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const setting = target.dataset.setting;
      if (!setting) return;

      if (target.type === "checkbox") state.settings[setting] = !!target.checked;
      else state.settings[setting] = Math.max(0, parseInt(target.value || "0", 10));

      saveSettings();
      pruneByRetention();
      annotateVisibleRows();
      renderPanel();
    });

    window.addEventListener("resize", () => {
      const rect = panel.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
    });

    // Persist on navigation or tab switch — safety net for the interval flush.
    window.addEventListener("beforeunload", flushState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushState();
    });
  }

  function ensurePanelOnTop() {
    if (!state.panel) return;
    // OpenSea re-renders large DOM chunks. Re-append to guarantee the panel
    // stays as the last child of <html>, above everything else.
    const last = document.documentElement.lastElementChild;
    if (last !== state.panel) document.documentElement.appendChild(state.panel);
  }

  function annotateVisibleRows() {
    const rows = [...document.querySelectorAll('[data-osmm-row="1"]')];
    const firstByCollection = new Set();
    const now = Date.now();

    rows.forEach((row) => {
      row.classList.remove("osmm-dim-repeat", "osmm-hot-row");
      const key = row.dataset.osmmCollectionKey;
      if (!key) return;
      const col = state.collections.get(key);
      if (!col) return;

      // Highlight rows of collections that are hot in the last minute.
      // Threshold 3 avoids reacting to a single mint.
      const metrics = getMetrics(col, now);
      if (metrics.hotCount >= 3) row.classList.add("osmm-hot-row");

      if (state.settings.dimRepeats) {
        if (firstByCollection.has(key)) row.classList.add("osmm-dim-repeat");
        else firstByCollection.add(key);
      }
    });
  }

  function isCollectionFresh(col, now) {
    return now - col.discoveredAt < CONFIG.freshDurationMs;
  }

  function collectionPassesFilters(col, stats) {
    const now = Date.now();
    const retention = getRetentionMs();

    if (now - col.lastSeen > retention) return false;
    if (col.events.length < state.settings.minMints) return false;

    const hasAnyOffer = !!(stats && stats.topOffer && typeof stats.topOffer.unit === "number" && stats.topOffer.unit > 0);
    if (state.settings.onlyWithOffer && !hasAnyOffer) return false;

    if (state.settings.onlyOfferAboveMint) {
      const mint = getEffectiveMintPrice(col, stats);
      const offer = stats && stats.topOffer ? stats.topOffer.unit : null;
      if (mint === null || offer === null) return false;
      if (!(offer > mint)) return false;
    }
    return true;
  }

  function renderPanel() {
    if (!state.panel) return;

    const now = Date.now();
    const retention = getRetentionMs();
    const newCards = [];
    const seenCards = [];

    for (const col of state.collections.values()) {
      const statsRec = col.slug ? state.stats.get(col.slug) : null;
      const stats = statsRec && statsRec.ok ? statsRec.data : null;

      if (!collectionPassesFilters(col, stats)) continue;

      const bucket = state.seen.has(col.key) ? seenCards : newCards;
      bucket.push({ col, stats, statsRec });
    }

    // NEW section: freshest at the top so newly-arrived collections are
    // immediately visible without scrolling.
    newCards.sort((a, b) => b.col.discoveredAt - a.col.discoveredAt);
    // SEEN section: most recent activity at the top.
    seenCards.sort((a, b) => b.col.lastSeen - a.col.lastSeen);

    state.summaryEl.innerHTML = `
      <strong>${newCards.length}</strong> new · <strong>${seenCards.length}</strong> seen ·
      window <strong>${Math.round(retention / 60000)}m</strong>
    `;

    state.statusEl.textContent = state.paused
      ? "paused"
      : `live · last scan ${state.lastScanAt ? formatAgo(state.lastScanAt, now) : "now"} ago · fetch queue: ${state.fetchQueue.length}`;

    state.debugEl.textContent = `debug: candidate rows=${state.lastRowsFound}, mint rows=${state.lastMintRowsFound}`;

    if (!newCards.length && !seenCards.length) {
      state.listEl.innerHTML = `
        <div class="osmm-empty">
          Nothing matches the current filters.<br>
          Try lowering "min mints" or turning off the offer filters.
        </div>
      `;
      return;
    }

    const parts = [];

    parts.push(`
      <div class="osmm-section-header">
        <span>NEW <span class="osmm-section-count">${newCards.length}</span></span>
        <span class="osmm-section-toggle">freshest first</span>
      </div>
    `);
    if (newCards.length) {
      parts.push(newCards.map((c) => renderCard(c, now, false)).join(""));
    } else {
      parts.push(`<div class="osmm-empty">No unseen collections right now.</div>`);
    }

    if (seenCards.length) {
      const toggleLabel = state.settings.seenCollapsed ? "show" : "hide";
      parts.push(`
        <div class="osmm-section-header" data-action="toggle-seen">
          <span>SEEN <span class="osmm-section-count">${seenCards.length}</span></span>
          <span class="osmm-section-toggle">${toggleLabel}</span>
        </div>
      `);
      if (!state.settings.seenCollapsed) {
        parts.push(seenCards.map((c) => renderCard(c, now, true)).join(""));
      }
    }

    state.listEl.innerHTML = parts.join("");
  }

  function renderCard({ col, stats, statsRec }, now, isSeen) {
    const fresh = !isSeen && isCollectionFresh(col, now);

    // The pulse plays once per collection per page load. We use a Set (not
    // localStorage) so a refresh replays the pulse — that is intentional,
    // because after F5 you want to see what actually arrived fresh again.
    const justArrived = fresh && !state.pulsed.has(col.key);
    if (justArrived) state.pulsed.add(col.key);

    const classes = ["osmm-card"];
    if (fresh) classes.push("osmm-card-fresh");
    if (isSeen) classes.push("osmm-card-seen");
    if (justArrived) classes.push("osmm-card-just-arrived");

    const targetUrl = col.collectionUrl || col.itemUrl || "#";
    const verified = stats && stats.isVerified ? `<span class="osmm-verified" title="Verified">✓</span>` : "";
    const newBadge = fresh ? `<span class="osmm-badge-new">NEW</span>` : "";

    const metrics = getMetrics(col, now);
    const floorStr = stats && stats.floor ? formatUnit(stats.floor.unit, stats.floor.symbol)
      : (statsRec && statsRec.loading ? '<span class="osmm-loading">loading…</span>' : "—");
    const offerStr = stats && stats.topOffer ? formatUnit(stats.topOffer.unit, stats.topOffer.symbol) : "—";
    const volStr = stats && stats.volume24h ? formatUnit(stats.volume24h.unit, stats.volume24h.symbol) : "—";
    const itemsStr = stats && (stats.totalSupply || stats.maxSupply)
      ? `${stats.totalSupply || "?"}${stats.maxSupply ? " / " + stats.maxSupply : ""}` : "—";
    const ownersStr = stats && stats.ownerCount !== null ? String(stats.ownerCount) : "—";
    const mintingBadge = stats && stats.isMinting ? " · <b>minting</b>" : "";
    const effectiveMint = getEffectiveMintPrice(col, stats);
    const mintPriceStr = effectiveMint !== null ? `${effectiveMint}` : (col.lastPrice ? formatPrice(col.lastPrice) : "—");

    return `
      <div class="${classes.join(" ")}">
        <div class="osmm-card-top">
          <div class="osmm-name">${escapeHtml(col.name || "Unknown")}${verified}${newBadge}</div>
          <div class="osmm-chain">${escapeHtml((stats && stats.chainName) || col.chain || "Unknown")}</div>
        </div>
        <div class="osmm-metrics">
          <span>1m: <b>${metrics.hotCount}</b></span>
          <span>total: <b>${metrics.total}</b></span>${mintingBadge}
        </div>
        <div class="osmm-stats">
          <span>mint: <b>${escapeHtml(mintPriceStr)}</b></span>
          <span>floor: <b>${floorStr}</b></span>
          <span>offer: <b>${offerStr}</b></span>
        </div>
        <div class="osmm-meta">
          <span>24h vol: <b>${volStr}</b></span>
          <span>items: <b>${itemsStr}</b></span>
          <span>owners: <b>${ownersStr}</b></span>
          <span>last: <b>${escapeHtml(formatAgo(col.lastSeen, now))}</b></span>
        </div>
        <div class="osmm-links">
          <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer"
             data-role="open-collection" data-collection-key="${escapeHtml(col.key)}">open collection</a>
          ${col.itemUrl && col.collectionUrl && col.itemUrl !== col.collectionUrl
            ? `<a href="${escapeHtml(col.itemUrl)}" target="_blank" rel="noopener noreferrer">last item</a>` : ""}
        </div>
      </div>
    `;
  }

  // ==================== SCAN LOOP ====================

  function scanPage() {
    if (state.paused) return;
    createPanel();
    ensurePanelOnTop();

    const rows = collectRowCandidates();
    state.lastRowsFound = rows.length;

    let mintRows = 0;
    let brandNewCollections = 0;

    for (const row of rows) {
      const meta = extractEventMeta(row);
      if (!meta) continue;
      mintRows += 1;

      // Tag the DOM row so annotateVisibleRows can style it without re-parsing.
      row.dataset.osmmRow = "1";
      row.dataset.osmmCollectionKey = meta.collectionKey;
      row.dataset.osmmEventKey = meta.eventKey;

      if (state.eventSeen.has(meta.eventKey)) continue;

      state.eventSeen.set(meta.eventKey, meta.seenAt);
      const wasBrandNew = addEvent(meta);
      if (wasBrandNew) brandNewCollections += 1;
    }

    state.lastMintRowsFound = mintRows;

    pruneByRetention();
    annotateVisibleRows();

    state.lastScanAt = Date.now();
    renderPanel();

    log("scan:", "rows=" + rows.length, "mint=" + mintRows,
        "collections=" + state.collections.size,
        "brand-new=" + brandNewCollections);
  }

  function scheduleScanSoon() {
    if (scanScheduled) return;
    scanScheduled = true;
    // 250ms debounce coalesces DOM mutation bursts into one scan.
    setTimeout(() => { scanScheduled = false; scanPage(); }, 250);
  }

  function attachObserver() {
    if (state.observer) return;
    if (!document.body) return;
    state.observer = new MutationObserver(() => {
      if (state.paused) return;
      scheduleScanSoon();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    loadSettings();
    loadSeen();
    loadState();
    createPanel();
    attachObserver();
    if (!state.scanTimerId) state.scanTimerId = setInterval(scanPage, CONFIG.scanIntervalMs);
    if (!state.saveTimerId) state.saveTimerId = setInterval(flushState, CONFIG.stateSaveIntervalMs);
    scanPage();
  }

  function boot() {
    if (document.body) start();
    else {
      // OpenSea sometimes ships the script before <body> exists.
      const bootObserver = new MutationObserver(() => {
        if (document.body) { bootObserver.disconnect(); start(); }
      });
      bootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  state.routeKey = `${location.pathname}${location.search}`;
  // Poll for URL changes: OpenSea is an SPA, filter chip clicks do not fire full loads.
  state.routeTimerId = setInterval(() => {
    const current = `${location.pathname}${location.search}`;
    if (current !== state.routeKey) {
      state.routeKey = current;
      log("route change:", current);
      setTimeout(scanPage, 500);
    }
  }, 1000);

  boot();
})();