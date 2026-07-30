(() => {
  if (window.__OSMM_LOADED__) return;
  window.__OSMM_LOADED__ = true;

  const LOG_PREFIX = "[OSMM]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);

  log("loaded", location.href);

  // ==================== CONFIG ====================
  // https://github.com/NazarovEmil/opensea-mint-monitor
  // All timings are in milliseconds unless noted otherwise.
  const CONFIG = {
    // Full scan of the DOM every 1.5s. Fast enough to catch new mints,
    // slow enough not to burn CPU while OpenSea streams the feed.
    scanIntervalMs: 1500,

    // Rolling "hot right now" window: how many mints happened in the last minute.
    // Used only for sorting/heat coloring, not for filtering.
    hotWindowMs: 60 * 1000,

    // Defaults for user-facing filters. See onboarding below.
    defaultWindowMinutes: 60, // Keep and display last 60 minutes of activity.
    defaultMinMints: 1,       // Show a collection if it had at least 1 mint in the window.
    defaultMinProfitPct: 20,  // Highlight collections where floor is ≥20% above mint price.

    // LocalStorage keys. Bumped when the schema changes.
    positionStorageKey: "osmm-panel-pos-v1",
    stateStorageKey: "osmm-state-v3",
    settingsStorageKey: "osmm-settings-v2",

    // Flush in-memory state to localStorage every 5s so a refresh
    // (or a crashed tab) does not lose the last minute of collected data.
    stateSaveIntervalMs: 5000,

    // Hard bounds for the retention window so a user cannot accidentally
    // store weeks of data (localStorage cap is ~5MB per origin).
    minRetentionMs: 60 * 1000,          // 1 minute
    maxRetentionMs: 24 * 60 * 60 * 1000, // 24 hours

    // OpenSea GraphQL endpoint that powers the hover tooltip on collection
    // rows. We reuse the exact same persisted query the site itself uses.
    graphqlUrl: "https://gql.opensea.io/graphql",
    tooltipQueryName: "CollectionPreviewTooltipContentQuery",
    tooltipQueryHash: "761282bbf059601b6b02e7c6061a4be4f7958d28a3b386a1305295d9b1d2fd81",

    // Rate-limit for stats requests: at most one request per 400ms.
    // OpenSea's public rate limit is ~4 req/s per IP, we stay well under it.
    fetchGapMs: 400,

    // How often we allow a stats refresh for the same collection.
    // Floor/offer/volume rarely change faster than this.
    statsRefreshMs: 2 * 60 * 1000,
    // If a stats fetch failed, wait at least this long before retrying.
    statsFailRetryMs: 30 * 1000,

    // Safety cap: even in a mint frenzy we never store more than this
    // many events per collection. Old ones get dropped first.
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
      onlyProfitable: false,
      onlyWithOffer: false,
      minProfitPct: CONFIG.defaultMinProfitPct
    },
    // eventSeen maps eventKey → timestamp, so we never count the same
    // physical mint twice even if OpenSea re-renders the row.
    eventSeen: new Map(),
    // collections maps collectionKey → { events, name, chain, ... }
    // This is the source of truth. The visible DOM feed is just an input.
    collections: new Map(),
    // stats maps slug → { data, loading, ok, fetchedAt } for GraphQL results.
    stats: new Map(),
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
    // Match a numeric amount followed by a known token symbol.
    // USDG is included because Robinhood Chain uses it.
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
    // Check accessibility attributes first (chain icon usually has alt text),
    // fall back to the visible text of the row.
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

    // Strategy 1: real <tr> elements in a proper table.
    document.querySelectorAll('tr[role="row"], tr').forEach((el) => {
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
      // Require at least 3 cells so we don't grab header/summary rows.
      if (cells.length >= 3) set.add(el);
    });

    // Strategy 2: ARIA rows (OpenSea sometimes renders div-based grids).
    document.querySelectorAll('[role="row"]').forEach((el) => {
      if (el.tagName === "TR") return;
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('[role="cell"], [role="gridcell"]');
      if (cells.length >= 3) set.add(el);
    });

    // Strategy 3: fallback — walk up from any item/collection anchor
    // until we find an ancestor that looks like a mint row.
    const main = document.querySelector("main") || document.body;
    main.querySelectorAll("a[href]").forEach((anchor) => {
      if (!isItemLink(anchor.href) && !isCollectionLink(anchor.href)) return;
      let el = anchor;
      // Cap the walk at 10 levels — deeper than that is almost certainly noise.
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

    // Grab all leaf-node texts inside the item cell — the first two usually are
    // "#853" (token id) and "Hoodboyzz" (collection name).
    const leafTexts = [];
    search.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = normalizeText(el.textContent || "");
        // 2..120 chars: filters out empty spans and giant paragraphs.
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
      // Skip subtitles that are just token ids like "#123".
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
    // Scan from the last cell backwards — "TIME" is usually the rightmost column.
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
    // don't create phantom duplicate events for the same physical mint.
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
    if (!col) {
      col = {
        key: meta.collectionKey, slug: meta.slug,
        name: meta.name, chain: meta.chain,
        collectionUrl: meta.collectionUrl, itemUrl: meta.itemUrl,
        firstSeen: meta.seenAt, lastSeen: meta.seenAt,
        lastPrice: meta.price, events: []
      };
      state.collections.set(meta.collectionKey, col);
    }

    // Enrich existing collection with anything new we learned this scan.
    col.name = meta.name || col.name;
    col.chain = meta.chain || col.chain;
    col.collectionUrl = meta.collectionUrl || col.collectionUrl;
    col.itemUrl = meta.itemUrl || col.itemUrl;
    col.slug = col.slug || meta.slug;
    col.lastSeen = Math.max(col.lastSeen, meta.seenAt);
    col.firstSeen = Math.min(col.firstSeen, meta.seenAt);
    if (meta.price) col.lastPrice = meta.price;

    col.events.push({ ts: meta.seenAt, price: meta.price });

    // Trim to the safety cap — drop the oldest events first.
    if (col.events.length > CONFIG.maxEventsPerCollection) {
      col.events.splice(0, col.events.length - CONFIG.maxEventsPerCollection);
    }

    state.dirty = true;
    if (col.slug) enqueueStatsFetch(col.slug);
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
  // We snapshot both settings and event history to localStorage so a
  // page refresh (or accidental navigation) doesn't wipe the last hour.

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

      const now = Date.now();
      const cutoff = now - getRetentionMs();

      payload.collections.forEach((c) => {
        const events = (c.events || []).filter((e) => e && e.ts >= cutoff);
        if (!events.length) return;
        state.collections.set(c.key, {
          key: c.key, slug: c.slug || null,
          name: c.name || "Unknown", chain: c.chain || "Unknown",
          collectionUrl: c.collectionUrl || null,
          itemUrl: c.itemUrl || null,
          firstSeen: events[0].ts, lastSeen: events[events.length - 1].ts,
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
      // Enforce the rate-limit gap between consecutive fetches.
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
      // credentials: "include" reuses the user's OpenSea session cookies,
      // otherwise the API may return 401/403.
      method: "GET", credentials: "include",
      headers: { accept: "application/json" }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function parsePriceObj(obj) {
    // OpenSea's GraphQL wraps prices in several shapes depending on context.
    // Try the common ones in order of specificity.
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

  function computeProfit(col, stats) {
    if (!stats) return { deltaFloorPct: null, deltaOfferPct: null, effectiveMint: null };

    // Prefer the authoritative mint price from the drop configuration.
    // Fall back to whatever price we scraped from the mint row.
    let effectiveMint = null;
    if (stats.mintPrice && typeof stats.mintPrice.unit === "number") {
      effectiveMint = stats.mintPrice.unit;
    } else if (col.lastPrice && typeof col.lastPrice.amount === "number") {
      effectiveMint = col.lastPrice.amount;
    }

    let deltaFloorPct = null;
    let deltaOfferPct = null;

    if (effectiveMint !== null && stats.floor && typeof stats.floor.unit === "number") {
      if (effectiveMint > 0) deltaFloorPct = ((stats.floor.unit - effectiveMint) / effectiveMint) * 100;
      // Free mint (mint = 0) with a positive floor: represent as a huge delta
      // so it sorts to the top but doesn't overflow the number formatter.
      else if (stats.floor.unit > 0) deltaFloorPct = 9999;
    }
    if (effectiveMint !== null && stats.topOffer && typeof stats.topOffer.unit === "number") {
      if (effectiveMint > 0) deltaOfferPct = ((stats.topOffer.unit - effectiveMint) / effectiveMint) * 100;
      else if (stats.topOffer.unit > 0) deltaOfferPct = 9999;
    }

    return { deltaFloorPct, deltaOfferPct, effectiveMint };
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

  function formatDeltaPct(pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return "—";
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(0)}%`;
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
    // Keep the panel visible: leave at least 100px on the right and 40px on the bottom.
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
    // 14px inset matches the default padding used across OpenSea's UI.
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
          <label title="Highlight collections where floor is at least this much above the mint price">
            profit ≥
            <input type="number" min="0" max="10000" step="5" data-setting="minProfitPct" value="${state.settings.minProfitPct}" />
            %
          </label>
        </div>
        <div class="osmm-controls osmm-controls-compact">
          <label class="osmm-check">
            <input type="checkbox" data-setting="onlyProfitable" ${state.settings.onlyProfitable ? "checked" : ""} />
            only floor > mint
          </label>
          <label class="osmm-check">
            <input type="checkbox" data-setting="onlyWithOffer" ${state.settings.onlyWithOffer ? "checked" : ""} />
            only offer > mint
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

    // Persist state on navigation or tab switch — safety net for the interval flush.
    window.addEventListener("beforeunload", flushState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushState();
    });
  }

  function ensurePanelOnTop() {
    if (!state.panel) return;
    // OpenSea occasionally re-renders large chunks of the DOM. Re-append
    // the panel to guarantee it stays as the last child, above everything else.
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

      // Green outline for collections that are "hot" (many mints in the last minute).
      const metrics = getMetrics(col, now);
      // 3+ mints in the last minute qualifies as noticeably active.
      if (metrics.hotCount >= 3) row.classList.add("osmm-hot-row");

      if (state.settings.dimRepeats) {
        if (firstByCollection.has(key)) row.classList.add("osmm-dim-repeat");
        else firstByCollection.add(key);
      }
    });
  }

  function renderPanel() {
    if (!state.panel) return;

    const now = Date.now();
    const retention = getRetentionMs();
    const active = [];

    for (const col of state.collections.values()) {
      // A collection stays visible as long as it had at least `minMints` mints
      // inside the current retention window. This is exactly what the user asked:
      // "keep collections that had at least 1 mint in the last N minutes".
      if (now - col.lastSeen > retention) continue;
      if (col.events.length < state.settings.minMints) continue;

      const metrics = getMetrics(col, now);
      const statsRec = col.slug ? state.stats.get(col.slug) : null;
      const stats = statsRec && statsRec.ok ? statsRec.data : null;
      const profit = computeProfit(col, stats);

      if (state.settings.onlyProfitable) {
        if (profit.deltaFloorPct === null || profit.deltaFloorPct < state.settings.minProfitPct) continue;
      }
      if (state.settings.onlyWithOffer) {
        if (profit.deltaOfferPct === null || profit.deltaOfferPct < state.settings.minProfitPct) continue;
      }

      active.push({ col, metrics, stats, statsRec, profit });
    }

    // Sort by profit first (best flip opportunities on top),
    // then by recent activity so live drops always surface.
    active.sort((a, b) => {
      const pa = a.profit.deltaFloorPct !== null ? a.profit.deltaFloorPct : -Infinity;
      const pb = b.profit.deltaFloorPct !== null ? b.profit.deltaFloorPct : -Infinity;
      if (pb !== pa) return pb - pa;
      return b.metrics.hotCount - a.metrics.hotCount || b.col.lastSeen - a.col.lastSeen;
    });

    state.summaryEl.innerHTML = `
      <strong>${active.length}</strong> shown /
      ${state.collections.size} tracked · window <strong>${Math.round(retention / 60000)}m</strong> ·
      stats: ${state.stats.size}
    `;

    state.statusEl.textContent = state.paused
      ? "paused"
      : `live · last scan ${state.lastScanAt ? formatAgo(state.lastScanAt, now) : "now"} ago · fetch queue: ${state.fetchQueue.length}`;

    state.debugEl.textContent = `debug: candidate rows=${state.lastRowsFound}, mint rows=${state.lastMintRowsFound}`;

    if (!active.length) {
      state.listEl.innerHTML = `
        <div class="osmm-empty">
          Nothing matches the current filters.<br>
          Try lowering "min mints" or increasing "window".
        </div>
      `;
      return;
    }

    state.listEl.innerHTML = active.map(({ col, metrics, stats, statsRec, profit }) => {
      const isHotByProfit = profit.deltaFloorPct !== null && profit.deltaFloorPct >= state.settings.minProfitPct;
      let heatClass;
      // Priority: profit > raw velocity. A profitable card is always more useful than a fast one.
      if (isHotByProfit) heatClass = "osmm-card osmm-card-profit";
      else if (metrics.hotCount >= 4) heatClass = "osmm-card osmm-card-hot";
      else if (metrics.hotCount >= 2) heatClass = "osmm-card osmm-card-warm";
      else heatClass = "osmm-card";

      const targetUrl = col.collectionUrl || col.itemUrl || "#";
      const verified = stats && stats.isVerified ? `<span class="osmm-verified" title="Verified">✓</span>` : "";

      const floorStr = stats && stats.floor ? formatUnit(stats.floor.unit, stats.floor.symbol)
        : (statsRec && statsRec.loading ? '<span class="osmm-loading">loading…</span>' : "—");
      const offerStr = stats && stats.topOffer ? formatUnit(stats.topOffer.unit, stats.topOffer.symbol) : "—";
      const volStr = stats && stats.volume24h ? formatUnit(stats.volume24h.unit, stats.volume24h.symbol) : "—";
      const itemsStr = stats && (stats.totalSupply || stats.maxSupply)
        ? `${stats.totalSupply || "?"}${stats.maxSupply ? " / " + stats.maxSupply : ""}` : "—";
      const ownersStr = stats && stats.ownerCount !== null ? String(stats.ownerCount) : "—";
      const mintingBadge = stats && stats.isMinting ? " · <b>minting</b>" : "";

      const deltaFloorClass = profit.deltaFloorPct === null ? "osmm-delta-neutral"
        : profit.deltaFloorPct > 0 ? "osmm-delta-good" : "osmm-delta-bad";
      const deltaOfferClass = profit.deltaOfferPct === null ? "osmm-delta-neutral"
        : profit.deltaOfferPct > 0 ? "osmm-delta-good" : "osmm-delta-bad";

      const mintPriceStr = profit.effectiveMint !== null ? `${profit.effectiveMint}`
        : (col.lastPrice ? formatPrice(col.lastPrice) : "—");

      return `
        <div class="${heatClass}">
          <div class="osmm-card-top">
            <div class="osmm-name">${escapeHtml(col.name || "Unknown")}${verified}</div>
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
          <div class="osmm-stats">
            <span>Δ floor: <b class="${deltaFloorClass}">${escapeHtml(formatDeltaPct(profit.deltaFloorPct))}</b></span>
            <span>Δ offer: <b class="${deltaOfferClass}">${escapeHtml(formatDeltaPct(profit.deltaOfferPct))}</b></span>
            <span>24h vol: <b>${volStr}</b></span>
          </div>
          <div class="osmm-meta">
            <span>items: <b>${itemsStr}</b></span>
            <span>owners: <b>${ownersStr}</b></span>
            <span>last: <b>${escapeHtml(formatAgo(col.lastSeen, now))}</b></span>
            <span>first: <b>${escapeHtml(formatAgo(col.firstSeen, now))}</b></span>
          </div>
          <div class="osmm-links">
            <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer">open collection</a>
            ${col.itemUrl && col.collectionUrl && col.itemUrl !== col.collectionUrl
              ? `<a href="${escapeHtml(col.itemUrl)}" target="_blank" rel="noopener noreferrer">last item</a>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  // ==================== SCAN LOOP ====================

  function scanPage() {
    if (state.paused) return;
    createPanel();
    ensurePanelOnTop();

    const rows = collectRowCandidates();
    state.lastRowsFound = rows.length;

    let mintRows = 0;

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
      addEvent(meta);
    }

    state.lastMintRowsFound = mintRows;

    pruneByRetention();
    annotateVisibleRows();

    state.lastScanAt = Date.now();
    renderPanel();

    log("scan:", "rows=" + rows.length, "mint=" + mintRows,
        "collections=" + state.collections.size, "events=" + state.eventSeen.size);
  }

  function scheduleScanSoon() {
    if (scanScheduled) return;
    scanScheduled = true;
    // 250ms debounce: coalesce bursts of DOM mutations into one scan.
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
      // Wait until the body is attached, then start once.
      const bootObserver = new MutationObserver(() => {
        if (document.body) { bootObserver.disconnect(); start(); }
      });
      bootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  state.routeKey = `${location.pathname}${location.search}`;
  // Poll for URL changes: OpenSea is an SPA and doesn't fire full page loads
  // when the filter chips (chain / market / event type) change.
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