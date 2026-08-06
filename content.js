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

    // "Hot right now" window used for the row outline and one metric on the card.
    hotWindowMs: 60 * 1000,

    // A collection is treated as brand-new for 60 seconds after we first saw it.
    freshDurationMs: 60 * 1000,

    // Defaults for user-facing filters.
    defaultWindowMinutes: 60,
    defaultMinMints: 1,

    // LocalStorage keys. Bumped when the schema changes.
    positionStorageKey: "osmm-panel-pos-v1",
    stateStorageKey: "osmm-state-v5",
    settingsStorageKey: "osmm-settings-v4",
    seenStorageKey: "osmm-seen-v2",
    updateCheckStorageKey: "osmm-update-check-v1",

    // Flush state to localStorage every 5s.
    stateSaveIntervalMs: 5000,

    // Hard bounds for retention.
    minRetentionMs: 60 * 1000,
    maxRetentionMs: 24 * 60 * 60 * 1000,

    // "Seen" flag TTL: 7 days.
    seenRetentionMs: 7 * 24 * 60 * 60 * 1000,

    // OpenSea GraphQL endpoint.
    graphqlUrl: "https://gql.opensea.io/graphql",
    tooltipQueryName: "CollectionPreviewTooltipContentQuery",
    tooltipQueryHash: "761282bbf059601b6b02e7c6061a4be4f7958d28a3b386a1305295d9b1d2fd81",

    // Rate limits for the stats fetcher.
    fetchGapMs: 400,
    statsRefreshMs: 2 * 60 * 1000,
    statsFailRetryMs: 30 * 1000,

    // Safety cap on stored events per collection.
    maxEventsPerCollection: 2000,

    // Update check every 6 hours (4 requests/day out of 60/hour unauth limit).
    updateCheckIntervalMs: 6 * 60 * 60 * 1000,
    githubReleasesUrl: "https://api.github.com/repos/NazarovEmil/opensea-mint-monitor/releases/latest",
    repoUrl: "https://github.com/NazarovEmil/opensea-mint-monitor",
    authorChannelUrl: "https://t.me/mdropsss",
    authorChannelLabel: "@mdropsss"
  };

  // Fallback chain detection from row text — used only until GraphQL confirms.
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

  // Map various chain identifiers/names into a single canonical bucket used
  // for keying and de-duplication. Add more as you notice mismatches.
  const CHAIN_ALIASES = {
    "ethereum": "ethereum", "eth": "ethereum", "mainnet": "ethereum",
    "base": "base",
    "polygon": "polygon", "matic": "polygon", "pol": "polygon",
    "arbitrum": "arbitrum", "arb": "arbitrum",
    "optimism": "optimism", "op": "optimism",
    "avalanche": "avalanche", "avax": "avalanche",
    "solana": "solana", "sol": "solana",
    "bnb chain": "bnb", "bnb": "bnb",
    "blast": "blast",
    "zora": "zora",
    "apechain": "apechain", "ape chain": "apechain", "ape": "apechain",
    "ronin": "ronin",
    "robinhood": "robinhood", "robinhood chain": "robinhood", "rbh": "robinhood"
  };

  function canonicalizeChain(name) {
    if (!name) return null;
    const key = String(name).toLowerCase().trim();
    return CHAIN_ALIASES[key] || key.replace(/\s+/g, "-");
  }

  const state = {
    paused: false,
    panel: null,
    listEl: null,
    summaryEl: null,
    statusEl: null,
    headerEl: null,
    observer: null,
    scanTimerId: 0,
    routeTimerId: 0,
    saveTimerId: 0,
    routeKey: "",
    lastScanAt: 0,
    settings: {
      windowMinutes: CONFIG.defaultWindowMinutes,
      minMints: CONFIG.defaultMinMints,
      onlyWithOffer: false,
      onlyOfferAboveMint: false,
      seenCollapsed: false
    },
    eventSeen: new Map(),
    collections: new Map(),
    // Stats keyed by collection SLUG (that's what GraphQL takes as input).
    stats: new Map(),
    seen: new Map(),
    pulsed: new Set(),
    fetchHeap: [], // Priority queue of { slug, priority, enqueuedAt }
    fetchInQueue: new Map(), // slug → true, so we can update priorities in-place
    fetching: false,
    dirty: false,
    updateAvailable: null,
    // If OpenSea deploys a new frontend, our persistedQuery hash can start
    // returning 400/404. We flip this flag on the first hard failure and
    // stop the fetch queue until reload.
    statsBroken: null, // null | { at, reason }
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

  // Extract chain + contract address from an item URL like
  // /assets/ethereum/0xabc.../123 or /assets/base/0xdef.../456.
  // Contract addresses are the only stable per-collection identifier we can
  // trust when scammers clone names.
  function contractInfoFromItemUrl(url) {
    const path = pathFromUrl(url);
    // 0x address (EVM) — 40 hex chars.
    const m = path.match(/\/(assets|asset|item|items|nft)\/([^\/]+)\/(0x[a-f0-9]{40})(?:\/|$)/i);
    if (m) return { chainSlug: m[2], contract: m[3].toLowerCase() };
    // Non-EVM fallback (Solana, etc): allow any non-slash id in the contract slot.
    // We only trust it when preceded by an explicit chain identifier.
    const m2 = path.match(/\/(assets|asset|item|items|nft)\/([^\/]+)\/([^\/]{8,})(?:\/|$)/i);
    if (m2) return { chainSlug: m2[2], contract: m2[3].toLowerCase() };
    return null;
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

  function detectChainFromDom(fullText, row) {
    const accessible = collectAccessibleText(row);
    for (const chain of CHAIN_HINTS) if (chain.regex.test(accessible)) return chain.name;
    for (const chain of CHAIN_HINTS) if (chain.regex.test(fullText)) return chain.name;
    return null;
  }

  function looksLikeMintRow(text) { return /\bmint\b/i.test(text); }

  function getRetentionMs() {
    const requested = state.settings.windowMinutes * 60 * 1000;
    return Math.max(CONFIG.minRetentionMs, Math.min(CONFIG.maxRetentionMs, requested));
  }

  // ==================== VERSION CHECK ====================

  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function getInstalledVersion() {
    try {
      return (chrome && chrome.runtime && chrome.runtime.getManifest().version) || "0.0.0";
    } catch (e) { return "0.0.0"; }
  }

  async function checkForUpdate() {
    try {
      const raw = localStorage.getItem(CONFIG.updateCheckStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.checkedAt && Date.now() - parsed.checkedAt < CONFIG.updateCheckIntervalMs) {
          if (parsed.updateAvailable) {
            state.updateAvailable = parsed.updateAvailable;
            renderPanel();
          }
          return;
        }
      }
    } catch (e) {}

    try {
      const res = await fetch(CONFIG.githubReleasesUrl, {
        method: "GET", headers: { accept: "application/vnd.github+json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const latest = data && data.tag_name ? data.tag_name : null;
      if (!latest) return;
      const installed = getInstalledVersion();
      const isNewer = compareVersions(latest, installed) > 0;
      const updateAvailable = isNewer
        ? { latestVersion: latest, url: (data.html_url || CONFIG.repoUrl) }
        : null;
      localStorage.setItem(CONFIG.updateCheckStorageKey, JSON.stringify({
        checkedAt: Date.now(), installedAtCheck: installed, updateAvailable
      }));
      state.updateAvailable = updateAvailable;
      renderPanel();
    } catch (err) {
      log("update check failed:", err);
    }
  }

  // ==================== ROW EXTRACTION ====================

  function collectRowCandidates() {
    const set = new Set();

    document.querySelectorAll('tr[role="row"], tr').forEach((el) => {
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
      if (cells.length >= 3) set.add(el);
    });

    document.querySelectorAll('[role="row"]').forEach((el) => {
      if (el.tagName === "TR") return;
      const text = normalizeText(el.innerText || "");
      if (!text || !looksLikeMintRow(text)) return;
      const cells = el.querySelectorAll('[role="cell"], [role="gridcell"]');
      if (cells.length >= 3) set.add(el);
    });

    const main = document.querySelector("main") || document.body;
    main.querySelectorAll("a[href]").forEach((anchor) => {
      if (!isItemLink(anchor.href) && !isCollectionLink(anchor.href)) return;
      let el = anchor;
      for (let depth = 0; depth < 10 && el; depth += 1, el = el.parentElement) {
        if (!el) break;
        if (el.id === "osmm-panel") return;
        if (el.closest && el.closest("#osmm-panel")) return;
        const text = normalizeText(el.innerText || "");
        if (!text || !looksLikeMintRow(text)) continue;
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

    const leafTexts = [];
    search.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = normalizeText(el.textContent || "");
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
      if (subtitle && !/^#\d+/.test(subtitle)) collectionName = subtitle;
      else collectionName = title;
    }

    if (!collectionName) collectionName = "Unknown";

    return {
      name: collectionName,
      url: collectionUrl,
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
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const t = normalizeText(cells[i].innerText || "");
      if (/(\bjust now\b|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*(ago)?)/i.test(t)) {
        return extractRelativeTimestamp(t);
      }
    }
    return extractRelativeTimestamp(row.innerText || "");
  }

  // Build a stable collection key. Priority:
  //   1. chain + contract address (from /assets/... URL) — safest, resistant to name spoofing.
  //   2. slug (from /collection/... URL) — OpenSea guarantees slug uniqueness per chain.
  //   3. no key → we skip the event entirely (better than merging scam clones under one card).
  function buildCollectionKey(info, itemUrl, domChain) {
    const contractInfo = itemUrl ? contractInfoFromItemUrl(itemUrl) : null;

    if (contractInfo && contractInfo.contract) {
      const chainCanon = canonicalizeChain(contractInfo.chainSlug) || canonicalizeChain(domChain) || "unknown";
      return {
        key: `contract::${chainCanon}::${contractInfo.contract}`,
        chainCanon,
        contract: contractInfo.contract,
        slug: info.url ? slugFromCollectionUrl(info.url) : null
      };
    }

    const slug = info.url ? slugFromCollectionUrl(info.url) : null;
    if (slug) {
      const chainCanon = canonicalizeChain(domChain) || "unknown";
      return {
        key: `slug::${chainCanon}::${slug}`,
        chainCanon,
        contract: null,
        slug
      };
    }
    return null;
  }

  function extractEventMeta(row) {
    const rowText = normalizeText(row.innerText || "");
    if (!rowText || !looksLikeMintRow(rowText)) return null;

    const info = extractCollectionInfoFromRow(row);
    if (!info) return null;

    const domChain = detectChainFromDom(rowText, row);
    const keyInfo = buildCollectionKey(info, info.itemUrl, domChain);
    if (!keyInfo) return null; // No contract, no slug → skip. Prevents scam name-clone merging.

    const price = extractPriceFromRow(row);
    const seenAt = extractTimeFromRow(row);

    // 30s bucket dedupes "3m ago" → "4m ago" transitions for the same mint.
    const timeBucket = Math.round(seenAt / 30000);
    const eventKey = `${keyInfo.key}|${info.itemUrl || ""}|${timeBucket}`;

    return {
      eventKey,
      collectionKey: keyInfo.key,
      slug: keyInfo.slug,
      contract: keyInfo.contract,
      chainCanon: keyInfo.chainCanon,
      chainDisplay: domChain || "Unknown",
      name: info.name || "Unknown",
      collectionUrl: info.url,
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
        key: meta.collectionKey,
        slug: meta.slug,
        contract: meta.contract,
        chainCanon: meta.chainCanon,
        chainDisplay: meta.chainDisplay,
        name: meta.name,
        collectionUrl: meta.collectionUrl,
        itemUrl: meta.itemUrl,
        firstSeen: meta.seenAt,
        lastSeen: meta.seenAt,
        discoveredAt: Date.now(),
        lastPrice: meta.price,
        events: []
      };
      state.collections.set(meta.collectionKey, col);
    }

    col.name = meta.name || col.name;
    col.chainDisplay = col.chainDisplay || meta.chainDisplay;
    col.collectionUrl = meta.collectionUrl || col.collectionUrl;
    col.itemUrl = meta.itemUrl || col.itemUrl;
    col.slug = col.slug || meta.slug;
    col.contract = col.contract || meta.contract;
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

  // Migrate a collection to a new key. Used when GraphQL returns an authoritative
  // chain identifier that differs from the DOM-guessed one, and we discover we
  // have both "unknown::slug" and "base::slug" entries — merge them into the
  // authoritative one so counts don't double.
  function migrateCollectionKey(oldKey, newKey, authoritativeChainCanon, authoritativeChainDisplay) {
    if (oldKey === newKey) return;
    const oldCol = state.collections.get(oldKey);
    if (!oldCol) return;

    const target = state.collections.get(newKey);
    if (!target) {
      // Rename in place.
      oldCol.key = newKey;
      oldCol.chainCanon = authoritativeChainCanon;
      oldCol.chainDisplay = authoritativeChainDisplay || oldCol.chainDisplay;
      state.collections.delete(oldKey);
      state.collections.set(newKey, oldCol);
    } else {
      // Merge events and prefer non-null fields.
      target.events = target.events.concat(oldCol.events)
        .sort((a, b) => a.ts - b.ts)
        .slice(-CONFIG.maxEventsPerCollection);
      target.firstSeen = Math.min(target.firstSeen, oldCol.firstSeen);
      target.lastSeen = Math.max(target.lastSeen, oldCol.lastSeen);
      target.discoveredAt = Math.min(target.discoveredAt, oldCol.discoveredAt);
      target.name = target.name || oldCol.name;
      target.collectionUrl = target.collectionUrl || oldCol.collectionUrl;
      target.itemUrl = target.itemUrl || oldCol.itemUrl;
      target.slug = target.slug || oldCol.slug;
      target.contract = target.contract || oldCol.contract;
      target.lastPrice = target.lastPrice || oldCol.lastPrice;
      target.chainCanon = authoritativeChainCanon;
      target.chainDisplay = authoritativeChainDisplay || target.chainDisplay;
      state.collections.delete(oldKey);
    }

    // Carry pulsed/seen flags to the new key.
    if (state.pulsed.has(oldKey)) { state.pulsed.delete(oldKey); state.pulsed.add(newKey); }
    if (state.seen.has(oldKey))   { const ts = state.seen.get(oldKey); state.seen.delete(oldKey); state.seen.set(newKey, ts); saveSeen(); }
    state.dirty = true;
  }

  function pruneByRetention() {
    const now = Date.now();
    const cutoff = now - getRetentionMs();

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
          key: c.key, slug: c.slug, contract: c.contract,
          chainCanon: c.chainCanon, chainDisplay: c.chainDisplay,
          name: c.name,
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
          key: c.key,
          slug: c.slug || null,
          contract: c.contract || null,
          chainCanon: c.chainCanon || null,
          chainDisplay: c.chainDisplay || "Unknown",
          name: c.name || "Unknown",
          collectionUrl: c.collectionUrl || null,
          itemUrl: c.itemUrl || null,
          firstSeen: events[0].ts, lastSeen: events[events.length - 1].ts,
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

  // ==================== STATS FETCH (priority queue) ====================
  // Priority score: higher = fetched sooner.
  //   +1000 if brand-new (discoveredAt within freshDurationMs)
  //   +100 * hotCount (mints in the last minute)
  //   +1 if never fetched before
  //   -age_minutes (older discoveries slide down)
  function computeFetchPriority(slug) {
    let score = 0;
    const now = Date.now();
    let bestCol = null;
    for (const col of state.collections.values()) {
      if (col.slug !== slug) continue;
      if (!bestCol || col.discoveredAt > bestCol.discoveredAt) bestCol = col;
    }
    if (!bestCol) return 0;

    if (now - bestCol.discoveredAt < CONFIG.freshDurationMs) score += 1000;
    const { hotCount } = getMetrics(bestCol, now);
    score += hotCount * 100;

    const rec = state.stats.get(slug);
    if (!rec || !rec.fetchedAt) score += 1;

    const ageMinutes = (now - bestCol.discoveredAt) / 60000;
    score -= ageMinutes;

    return score;
  }

  function heapPush(item) {
    state.fetchHeap.push(item);
    // Simple sift-up on push, sift-down on pop. Heap is small in practice (<200),
    // so O(n log n) full re-sort would also be fine — heap is future-proofing.
    let i = state.fetchHeap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (state.fetchHeap[parent].priority >= state.fetchHeap[i].priority) break;
      [state.fetchHeap[parent], state.fetchHeap[i]] = [state.fetchHeap[i], state.fetchHeap[parent]];
      i = parent;
    }
  }

  function heapPop() {
    if (!state.fetchHeap.length) return null;
    const top = state.fetchHeap[0];
    const last = state.fetchHeap.pop();
    if (state.fetchHeap.length) {
      state.fetchHeap[0] = last;
      let i = 0;
      const n = state.fetchHeap.length;
      while (true) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let largest = i;
        if (l < n && state.fetchHeap[l].priority > state.fetchHeap[largest].priority) largest = l;
        if (r < n && state.fetchHeap[r].priority > state.fetchHeap[largest].priority) largest = r;
        if (largest === i) break;
        [state.fetchHeap[i], state.fetchHeap[largest]] = [state.fetchHeap[largest], state.fetchHeap[i]];
        i = largest;
      }
    }
    return top;
  }

  function enqueueStatsFetch(slug) {
    if (!slug) return;
    if (state.statsBroken) return; // Do not pile up requests to a broken endpoint.

    const existing = state.stats.get(slug);
    const now = Date.now();

    if (existing) {
      if (existing.loading) return;
      const age = now - (existing.fetchedAt || 0);
      if (existing.ok && age < CONFIG.statsRefreshMs) return;
      if (!existing.ok && age < CONFIG.statsFailRetryMs) return;
    } else {
      state.stats.set(slug, { loading: true, ok: false, fetchedAt: 0 });
    }

    const priority = computeFetchPriority(slug);
    if (state.fetchInQueue.has(slug)) {
      // Update in-place: replace the entry, then re-heapify by rebuilding.
      // For our sizes this is cheap and simpler than a decrease-key routine.
      for (let i = 0; i < state.fetchHeap.length; i += 1) {
        if (state.fetchHeap[i].slug === slug) { state.fetchHeap[i].priority = priority; break; }
      }
      state.fetchHeap.sort((a, b) => b.priority - a.priority);
    } else {
      state.fetchInQueue.set(slug, true);
      heapPush({ slug, priority, enqueuedAt: now });
    }

    runFetchQueue();
  }

  async function runFetchQueue() {
    if (state.fetching) return;
    if (state.statsBroken) return;
    state.fetching = true;

    while (state.fetchHeap.length && !state.statsBroken) {
      const top = heapPop();
      if (!top) break;
      const slug = top.slug;
      state.fetchInQueue.delete(slug);

      try {
        const record = state.stats.get(slug) || {};
        record.loading = true;
        state.stats.set(slug, record);

        const raw = await fetchCollectionStats(slug);
        const parsed = parseCollectionStats(raw);

        state.stats.set(slug, { loading: false, ok: true, fetchedAt: Date.now(), data: parsed });

        // Reconcile chain: if GraphQL knows a chain we didn't guess correctly,
        // migrate the key so counts are not split.
        if (parsed && parsed.chainId) {
          const authoritativeCanon = canonicalizeChain(parsed.chainId) || canonicalizeChain(parsed.chainName);
          if (authoritativeCanon) {
            for (const col of [...state.collections.values()]) {
              if (col.slug !== slug) continue;
              if (col.chainCanon === authoritativeCanon) continue;
              const rest = col.key.split("::").slice(1).join("::"); // drop the prefix::chain segment
              // rest is "oldChain::identifier" — replace only the chain part.
              const parts = col.key.split("::");
              if (parts.length >= 3) {
                parts[1] = authoritativeCanon;
                const newKey = parts.join("::");
                migrateCollectionKey(col.key, newKey, authoritativeCanon, parsed.chainName || col.chainDisplay);
              }
            }
          }
        }

        renderPanel();
      } catch (err) {
        console.warn(LOG_PREFIX, "stats fetch failed for", slug, err);
        const msg = String(err && err.message || err);
        state.stats.set(slug, { loading: false, ok: false, fetchedAt: Date.now(), error: msg });

        if (isHashBrokenError(msg)) {
          state.statsBroken = { at: Date.now(), reason: msg };
          log("persisted query looks broken, halting stats queue");
          renderPanel();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, CONFIG.fetchGapMs));
    }

    state.fetching = false;
  }

  // Detect the two common ways OpenSea's GraphQL rejects a stale persisted-query hash:
  //   - HTTP 400/404 on the request itself
  //   - HTTP 200 with an error "PersistedQueryNotFound"
  // Any of these means our hash needs to be updated in CONFIG.tooltipQueryHash.
  function isHashBrokenError(msg) {
    return /HTTP\s+40[0-4]/i.test(msg) || /PersistedQueryNotFound/i.test(msg);
  }

  async function fetchCollectionStats(slug) {
    const url = new URL(CONFIG.graphqlUrl);
    url.searchParams.set("operationName", CONFIG.tooltipQueryName);
    url.searchParams.set("variables", JSON.stringify({ collectionSlug: slug }));
    url.searchParams.set("extensions", JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: CONFIG.tooltipQueryHash }
    }));

    const res = await fetch(url.toString(), {
      method: "GET", credentials: "include",
      headers: { accept: "application/json" }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // GraphQL persisted-query error surface: check top-level errors[].
    if (json && Array.isArray(json.errors) && json.errors.length) {
      const firstMsg = json.errors[0].message || "GraphQL error";
      throw new Error(firstMsg);
    }
    return json;
  }

  function parsePriceObj(obj) {
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
          <div class="osmm-title-row">
            <span class="osmm-title">OpenSea Mint Monitor</span>
            <span class="osmm-status-slot"></span>
            <span class="osmm-update-slot"></span>
          </div>
          <div class="osmm-subtitle">
            by <a href="${escapeHtml(CONFIG.authorChannelUrl)}" target="_blank" rel="noopener noreferrer" class="osmm-author-link">${escapeHtml(CONFIG.authorChannelLabel)}</a>
            · drag me
          </div>
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
        <div class="osmm-list"></div>
      </div>
    `;

    (document.documentElement || document.body).appendChild(panel);

    state.panel = panel;
    state.headerEl = panel.querySelector('[data-role="drag-handle"]');
    state.listEl = panel.querySelector(".osmm-list");
    state.summaryEl = panel.querySelector(".osmm-summary");
    state.statusEl = panel.querySelector(".osmm-status");

    const saved = loadSavedPosition();
    if (saved) applyPosition(saved.left, saved.top); else snapTopRight();

    state.headerEl.addEventListener("mousedown", onDragStart);

    panel.addEventListener("click", (e) => {
      const openLink = e.target.closest("a[data-role='open-collection']");
      if (openLink) {
        const key = openLink.dataset.collectionKey;
        if (key) {
          state.seen.set(key, Date.now());
          saveSeen();
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

    window.addEventListener("beforeunload", flushState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushState();
    });
  }

  function ensurePanelOnTop() {
    if (!state.panel) return;
    const last = document.documentElement.lastElementChild;
    if (last !== state.panel) document.documentElement.appendChild(state.panel);
  }

  // Grouping-by-collection is always on. We still dim duplicate rows in the
  // native OpenSea feed so the eye can skim the page underneath the panel.
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

      const metrics = getMetrics(col, now);
      if (metrics.hotCount >= 3) row.classList.add("osmm-hot-row");

      if (firstByCollection.has(key)) row.classList.add("osmm-dim-repeat");
      else firstByCollection.add(key);
    });
  }

  function isCollectionFresh(col, now) {
    return now - col.discoveredAt < CONFIG.freshDurationMs;
  }

  function collectionPassesFilters(col, stats) {
    const now = Date.now();
    if (now - col.lastSeen > getRetentionMs()) return false;
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

  function renderHeaderSlots() {
    if (!state.panel) return;

    const statusSlot = state.panel.querySelector(".osmm-status-slot");
    if (statusSlot) {
      if (state.statsBroken) {
        statusSlot.innerHTML = `
          <a class="osmm-status-badge osmm-status-broken"
             href="${escapeHtml(CONFIG.repoUrl)}" target="_blank" rel="noopener noreferrer"
             title="OpenSea GraphQL rejected our persisted-query hash. The hash likely needs to be updated. Click to open the repo for an updated release.">
            ! stats broken
          </a>
        `;
      } else {
        statusSlot.innerHTML = "";
      }
    }

    const updateSlot = state.panel.querySelector(".osmm-update-slot");
    if (updateSlot) {
      if (state.updateAvailable) {
        updateSlot.innerHTML = `
          <a class="osmm-update-badge"
             href="${escapeHtml(state.updateAvailable.url)}"
             target="_blank" rel="noopener noreferrer"
             title="New version ${escapeHtml(state.updateAvailable.latestVersion)} available (installed ${escapeHtml(getInstalledVersion())})">
            ↑ update
          </a>
        `;
      } else {
        updateSlot.innerHTML = "";
      }
    }
  }

  function renderPanel() {
    if (!state.panel) return;

    renderHeaderSlots();

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

    newCards.sort((a, b) => b.col.discoveredAt - a.col.discoveredAt);
    seenCards.sort((a, b) => b.col.lastSeen - a.col.lastSeen);

    state.summaryEl.innerHTML = `
      <strong>${newCards.length}</strong> new · <strong>${seenCards.length}</strong> seen ·
      window <strong>${Math.round(retention / 60000)}m</strong>
    `;

    state.statusEl.textContent = state.paused
      ? "paused"
      : `live · last scan ${state.lastScanAt ? formatAgo(state.lastScanAt, now) : "now"} ago · fetch queue: ${state.fetchHeap.length}`;

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
    const chainDisplay = (stats && stats.chainName) || col.chainDisplay || "Unknown";

    return `
      <div class="${classes.join(" ")}">
        <div class="osmm-card-top">
          <div class="osmm-name">${escapeHtml(col.name || "Unknown")}${verified}${newBadge}</div>
          <div class="osmm-chain">${escapeHtml(chainDisplay)}</div>
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

    for (const row of rows) {
      const meta = extractEventMeta(row);
      if (!meta) continue;

      row.dataset.osmmRow = "1";
      row.dataset.osmmCollectionKey = meta.collectionKey;
      row.dataset.osmmEventKey = meta.eventKey;

      if (state.eventSeen.has(meta.eventKey)) continue;

      state.eventSeen.set(meta.eventKey, meta.seenAt);
      addEvent(meta);
    }

    pruneByRetention();
    annotateVisibleRows();

    state.lastScanAt = Date.now();
    renderPanel();
  }

  function scheduleScanSoon() {
    if (scanScheduled) return;
    scanScheduled = true;
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
    checkForUpdate();
    scanPage();
  }

  function isActivityPage() {
    return location.pathname === "/activity";
  }

  function removePanel() {
    if (state.panel && state.panel.parentNode) {
      state.panel.parentNode.removeChild(state.panel);
    }
    state.panel = null;
    state.listEl = null;
    state.summaryEl = null;
    state.statusEl = null;
    state.headerEl = null;
  }

  function boot() {
    if (!isActivityPage()) {
      log("not on /activity, standing by");
      return;
    }
    if (document.body) start();
    else {
      const bootObserver = new MutationObserver(() => {
        if (document.body) { bootObserver.disconnect(); start(); }
      });
      bootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  state.routeKey = `${location.pathname}${location.search}`;
  state.routeTimerId = setInterval(() => {
    const current = `${location.pathname}${location.search}`;
    if (current === state.routeKey) return;
    state.routeKey = current;
    log("route change:", current);

    if (isActivityPage()) {
      if (!state.panel) start();
      else setTimeout(scanPage, 500);
    } else if (state.panel) {
      log("left /activity, removing panel");
      removePanel();
    }
  }, 1000);

  boot();
})();