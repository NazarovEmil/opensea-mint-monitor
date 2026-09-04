(() => {
  if (window.__OSMM_LOADED__) return;
  window.__OSMM_LOADED__ = true;

  const LOG_PREFIX = "[OSMM]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  log("loaded", location.href);

  // ==================== CONFIG ====================
  // All timings are in milliseconds unless noted otherwise.
  const CONFIG = {
    scanIntervalMs: 1500,
    hotWindowMs: 60 * 1000,
    freshDurationMs: 60 * 1000,

    defaultWindowMinutes: 60,
    defaultMinMints: 1,
    defaultMinMinters: 1,

    // Storage keys. Bumped: state (event key schema), settings (minMinters).
    positionStorageKey: "osmm-panel-pos-v1",
    stateStorageKey: "osmm-state-v6",
    settingsStorageKey: "osmm-settings-v5",
    seenStorageKey: "osmm-seen-v2",
    updateCheckStorageKey: "osmm-update-check-v1",

    stateSaveIntervalMs: 5000,
    minRetentionMs: 60 * 1000,
    maxRetentionMs: 24 * 60 * 60 * 1000,
    seenRetentionMs: 7 * 24 * 60 * 60 * 1000,

    graphqlUrl: "https://gql.opensea.io/graphql",
    tooltipQueryName: "CollectionPreviewTooltipContentQuery",
    tooltipQueryHash: "c482f97837ee92c2943b770b704f5f0ad95728261f900c84fd2b76c393de7347",

    fetchGapMs: 400,
    rateLimitBackoffMs: 30 * 1000,
    statsRefreshMs: 2 * 60 * 1000,
    statsFailRetryMs: 30 * 1000,
    // How many consecutive 400/404/PersistedQueryNotFound before we declare the hash dead.
    brokenStrikesLimit: 2,

    maxEventsPerCollection: 2000,

    updateCheckIntervalMs: 6 * 60 * 60 * 1000,
    githubReleasesUrl: "https://api.github.com/repos/NazarovEmil/opensea-mint-monitor/releases/latest",
    repoUrl: "https://github.com/NazarovEmil/opensea-mint-monitor",
    authorChannelUrl: "https://t.me/mdropsss",
    authorChannelLabel: "@mdropsss"
  };

  const CELL_SELECTOR = 'td, th, [role="cell"], [role="gridcell"]';
  const ITEM_OR_COLLECTION_LINK_SELECTOR =
    'a[href*="/collection/"], a[href*="/assets/"], a[href*="/asset/"], a[href*="/item/"], a[href*="/items/"], a[href*="/nft/"]';

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

  // ==================== STATE ====================
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
      minMinters: CONFIG.defaultMinMinters,
      onlyWithOffer: false,
      onlyOfferAboveMint: false,
      seenCollapsed: false
    },
    eventSeen: new Map(),        // eventKey -> ts
    collections: new Map(),      // collectionKey -> col
    stats: new Map(),            // slug -> { loading, ok, fetchedAt, data?, error? }
    slugToContract: new Map(),   // slug -> { chainCanon, contract }
    seen: new Map(),             // collectionKey -> ts when user opened it
    pulsed: new Set(),
    fetchHeap: [],               // { slug, priority, enqueuedAt }
    fetchInQueue: new Map(),
    fetching: false,
    dirty: false,
    updateAvailable: null,
    statsBroken: null,           // null | { at, reason }
    brokenStrikes: 0,
    drag: { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 }
  };

  let scanScheduled = false;
  let initialized = false;
  let lastListHtml = "";
  // Remembers which event a given DOM node last produced, so a row that merely
  // "aged" (3m ago -> 4m ago) is not counted again.
  let rowMemo = new WeakMap();

  // ==================== UTILS ====================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Per-scan cache of innerText: innerText forces layout, and the same
  // ancestors get visited dozens of times per scan.
  function makeTextCache() {
    const m = new Map();
    return (el) => {
      let t = m.get(el);
      if (t === undefined) {
        t = normalizeText(el.innerText || "");
        m.set(el, t);
      }
      return t;
    };
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

  // /assets/<chain>/<contract>/<tokenId>
  function contractInfoFromItemUrl(url) {
    const path = pathFromUrl(url);
    const m = path.match(/\/(assets|asset|item|items|nft)\/([^\/]+)\/(0x[a-f0-9]{40})(?:\/|$)/i);
    if (m) return { chainSlug: m[2], contract: m[3].toLowerCase() };
    const m2 = path.match(/\/(assets|asset|item|items|nft)\/([^\/]+)\/([^\/]{8,})(?:\/|$)/i);
    if (m2) return { chainSlug: m2[2], contract: m2[3].toLowerCase() };
    return null;
  }

  // Relative time. Word boundary after the unit is essential:
  // "0.5 matic" must not become "5 minutes", "3 sales" must not become "3 seconds".
  const REL_TIME_RE = /(\d+)\s*(mo|months?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|y|yrs?|years?)\b(?:\s*ago)?/;

  function relUnitMs(u) {
    if (u.startsWith("mo")) return 30 * 864e5;
    switch (u[0]) {
      case "s": return 1e3;
      case "m": return 6e4;
      case "h": return 36e5;
      case "d": return 864e5;
      case "w": return 7 * 864e5;
      case "y": return 365 * 864e5;
      default: return 0;
    }
  }

  function extractRelativeTimestamp(text) {
    const now = Date.now();
    const t = normalizeText(text).toLowerCase();
    if (!t || /\bjust now\b/.test(t)) return now;
    const m = t.match(REL_TIME_RE);
    return m ? now - Number(m[1]) * relUnitMs(m[2]) : now;
  }

  function extractPrice(text) {
    const m = normalizeText(text).match(
      /(\d+(?:[.,]\d+)?)\s*(ETH|WETH|POL|MATIC|ARB|OP|AVAX|SOL|RBH|RH|BNB|USDC|USDT|USDG)\b/i
    );
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

  // "Mint Pass #12 — Sale" must not be treated as a mint. If the row has an
  // explicit event-type cell we trust it; otherwise fall back to the word test.
  const NON_MINT_EVENT_RE = /^(sale|sold|transfer|list(ing|ed)?|offer|bid|cancel(led)?|burn(ed)?)$/i;
  function isMintRow(el, txt) {
    const text = txt(el);
    if (!text || !/\bmint(ed)?\b/i.test(text)) return false;
    const cells = el.querySelectorAll(CELL_SELECTOR);
    for (const c of cells) {
      const t = txt(c);
      if (/^mint(ed)?$/i.test(t)) return true;
      if (NON_MINT_EVENT_RE.test(t)) return false;
    }
    return true;
  }

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
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version || "0.0.0";
      }
    } catch (e) {}
    return "0.0.0";
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
      const updateAvailable = compareVersions(latest, installed) > 0
        ? { latestVersion: latest, url: data.html_url || CONFIG.repoUrl }
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
  function collectRowCandidates(txt) {
    const set = new Set();

    document.querySelectorAll("tr").forEach((el) => {
      if (el.closest("#osmm-panel")) return;
      if (el.querySelectorAll(CELL_SELECTOR).length < 3) return; // cheap check first
      if (isMintRow(el, txt)) set.add(el);
    });

    document.querySelectorAll('[role="row"]').forEach((el) => {
      if (el.tagName === "TR" || el.closest("#osmm-panel")) return;
      if (el.querySelectorAll('[role="cell"], [role="gridcell"]').length < 3) return;
      if (isMintRow(el, txt)) set.add(el);
    });

    const main = document.querySelector("main") || document.body;
    main.querySelectorAll("a[href]").forEach((anchor) => {
      if (anchor.closest("#osmm-panel")) return;
      if (!isItemLink(anchor.href) && !isCollectionLink(anchor.href)) return;

      // Already-tagged container: re-use it (also handles React node re-use).
      const tagged = anchor.closest('[data-osmm-row="1"]');
      if (tagged) { set.add(tagged); return; }

      let el = anchor;
      for (let depth = 0; depth < 10 && el; depth += 1, el = el.parentElement) {
        if (el.tagName === "TR" || el.getAttribute("role") === "row") {
          if (isMintRow(el, txt)) set.add(el);
          break;
        }
        const text = txt(el);
        if (text.length < 10 || text.length > 2000) continue;
        if (!isMintRow(el, txt)) continue;
        set.add(el);
        break;
      }
    });

    // Drop candidates nested inside other candidates (keep the outermost row).
    const arr = [...set];
    return arr.filter((el) => !arr.some((o) => o !== el && o.contains(el)));
  }

  function pickItemCell(row) {
    for (const c of row.querySelectorAll(CELL_SELECTOR)) {
      if (c.querySelector(ITEM_OR_COLLECTION_LINK_SELECTOR)) return c;
    }
    return null;
  }

  function extractCollectionInfoFromRow(row) {
    const search = pickItemCell(row) || row;
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
      collectionName = (subtitle && !/^#\d+/.test(subtitle)) ? subtitle : title;
    }
    if (!collectionName) collectionName = "Unknown";

    return {
      name: collectionName,
      url: collectionUrl,
      itemUrl: itemAnchor ? canonicalUrl(itemAnchor.href) : null
    };
  }

  function extractPriceFromRow(row, txt) {
    for (const c of row.querySelectorAll(CELL_SELECTOR)) {
      const p = extractPrice(txt(c));
      if (p) return p;
    }
    return extractPrice(txt(row));
  }

  function extractTimeFromRow(row, txt) {
    // Absolute timestamp if OpenSea renders one — far more reliable.
    const timeEl = row.querySelector("time[datetime]");
    if (timeEl) {
      const t = Date.parse(timeEl.getAttribute("datetime"));
      if (!Number.isNaN(t)) return t;
    }
    const cells = [...row.querySelectorAll(CELL_SELECTOR)];
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const t = txt(cells[i]).toLowerCase();
      if (/\bjust now\b/.test(t) || REL_TIME_RE.test(t)) return extractRelativeTimestamp(t);
    }
    return extractRelativeTimestamp(txt(row));
  }

  // Wallet links (/0xabc...). Zero address (mint "from") is dropped.
  function extractWalletsFromRow(row) {
    const out = new Set();
    row.querySelectorAll("a[href]").forEach((a) => {
      const m = pathFromUrl(a.href).match(/^\/(0x[a-f0-9]{40})\/?$/);
      if (m && !/^0x0{40}$/.test(m[1])) out.add(m[1]);
    });
    return [...out].sort();
  }

  // Stable collection key. Priority: contract → known slug→contract → slug → skip.
  function buildCollectionKey(info, itemUrl, domChain) {
    const contractInfo = itemUrl ? contractInfoFromItemUrl(itemUrl) : null;
    const slug = info.url ? slugFromCollectionUrl(info.url) : null;

    if (contractInfo && contractInfo.contract) {
      const chainCanon = canonicalizeChain(contractInfo.chainSlug) || canonicalizeChain(domChain) || "unknown";
      if (slug) state.slugToContract.set(slug, { chainCanon, contract: contractInfo.contract });
      return { key: `contract::${chainCanon}::${contractInfo.contract}`, chainCanon, contract: contractInfo.contract, slug };
    }

    if (slug) {
      const known = state.slugToContract.get(slug);
      if (known && known.contract) {
        return { key: `contract::${known.chainCanon}::${known.contract}`, chainCanon: known.chainCanon, contract: known.contract, slug };
      }
      const chainCanon = canonicalizeChain(domChain) || "unknown";
      return { key: `slug::${chainCanon}::${slug}`, chainCanon, contract: null, slug };
    }

    return null;
  }

  function extractEventMeta(row, txt) {
    const rowText = txt(row);
    if (!rowText || !isMintRow(row, txt)) return null;

    const info = extractCollectionInfoFromRow(row);
    if (!info) return null;

    const domChain = detectChainFromDom(rowText, row);
    const keyInfo = buildCollectionKey(info, info.itemUrl, domChain);
    if (!keyInfo) return null;

    const price = extractPriceFromRow(row, txt);
    const seenAt = extractTimeFromRow(row, txt);
    const wallets = extractWalletsFromRow(row);

    // Event identity: collection + token + wallets. Time is NOT included when we
    // have a token URL — relative time drifts and would re-count the same mint.
    const baseKey = `${keyInfo.key}|${info.itemUrl || ""}|${wallets.join(",")}`;
    const eventKey = info.itemUrl ? baseKey : `${baseKey}|${Math.floor(seenAt / 120000)}`;

    return {
      eventKey,
      baseKey,
      collectionKey: keyInfo.key,
      slug: keyInfo.slug,
      contract: keyInfo.contract,
      chainCanon: keyInfo.chainCanon,
      chainDisplay: domChain || "Unknown",
      name: info.name || "Unknown",
      collectionUrl: info.url,
      itemUrl: info.itemUrl,
      wallets,
      price,
      seenAt
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

    col.events.push({ ts: meta.seenAt, price: meta.price, w: meta.wallets.length ? meta.wallets : undefined });
    if (col.events.length > CONFIG.maxEventsPerCollection) {
      col.events.splice(0, col.events.length - CONFIG.maxEventsPerCollection);
    }

    state.dirty = true;
    if (col.slug) enqueueStatsFetch(col.slug);
    return isFirstTimeSeen;
  }

  function migrateCollectionKey(oldKey, newKey, authoritativeChainCanon, authoritativeChainDisplay) {
    if (oldKey === newKey) return;
    const oldCol = state.collections.get(oldKey);
    if (!oldCol) return;

    const target = state.collections.get(newKey);
    if (!target) {
      oldCol.key = newKey;
      oldCol.chainCanon = authoritativeChainCanon;
      oldCol.chainDisplay = authoritativeChainDisplay || oldCol.chainDisplay;
      state.collections.delete(oldKey);
      state.collections.set(newKey, oldCol);
    } else {
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

    // Keep slug→contract in sync, otherwise the next slug-only row recreates
    // the old key and we migrate forever.
    const surv = state.collections.get(newKey);
    if (surv && surv.slug && surv.contract) {
      state.slugToContract.set(surv.slug, { chainCanon: authoritativeChainCanon, contract: surv.contract });
    }

    if (state.pulsed.has(oldKey)) { state.pulsed.delete(oldKey); state.pulsed.add(newKey); }
    if (state.seen.has(oldKey)) {
      const ts = state.seen.get(oldKey);
      state.seen.delete(oldKey);
      if (!state.seen.has(newKey)) state.seen.set(newKey, ts);
      saveSeen();
    }
    state.dirty = true;
  }

  function mergeSlugKeyedDuplicates() {
    for (const col of [...state.collections.values()]) {
      if (!col.key.startsWith("slug::") || !col.slug) continue;
      const known = state.slugToContract.get(col.slug);
      if (!known || !known.contract) continue;
      const newKey = `contract::${known.chainCanon}::${known.contract}`;
      if (newKey === col.key) continue;
      migrateCollectionKey(col.key, newKey, known.chainCanon, col.chainDisplay);
    }
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
        state.pulsed.delete(k);
        state.dirty = true;
        continue;
      }
      // Events are appended in DOM order, not time order — compute honestly.
      let lo = Infinity, hi = 0;
      for (const e of col.events) { if (e.ts < lo) lo = e.ts; if (e.ts > hi) hi = e.ts; }
      col.firstSeen = lo;
      col.lastSeen = hi;
    }

    // Drop stats for collections that no longer exist.
    const liveSlugs = new Set();
    for (const c of state.collections.values()) if (c.slug) liveSlugs.add(c.slug);
    for (const slug of [...state.stats.keys()]) {
      if (!liveSlugs.has(slug) && !state.fetchInQueue.has(slug)) state.stats.delete(slug);
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
    const minters = new Set();
    for (const e of col.events) {
      if (e.ts >= hotCutoff) hotCount += 1;
      if (e.w) for (const w of e.w) minters.add(w);
    }
    return { hotCount, total: col.events.length, minters: minters.size };
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
        eventSeen: [...state.eventSeen.entries()],
        slugToContract: [...state.slugToContract.entries()]
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
        const events = (c.events || []).filter((e) => e && typeof e.ts === "number" && e.ts >= cutoff);
        if (!events.length) return;
        let lo = Infinity, hi = 0;
        for (const e of events) { if (e.ts < lo) lo = e.ts; if (e.ts > hi) hi = e.ts; }
        state.collections.set(c.key, {
          key: c.key,
          slug: c.slug || null,
          contract: c.contract || null,
          chainCanon: c.chainCanon || null,
          chainDisplay: c.chainDisplay || "Unknown",
          name: c.name || "Unknown",
          collectionUrl: c.collectionUrl || null,
          itemUrl: c.itemUrl || null,
          firstSeen: lo, lastSeen: hi,
          discoveredAt: c.discoveredAt || lo,
          lastPrice: c.lastPrice || null,
          events
        });
      });

      if (Array.isArray(payload.eventSeen)) {
        payload.eventSeen.forEach(([k, ts]) => {
          if (typeof ts === "number" && ts >= cutoff) state.eventSeen.set(k, ts);
        });
      }
      if (Array.isArray(payload.slugToContract)) {
        payload.slugToContract.forEach(([k, v]) => {
          if (typeof k === "string" && v && v.contract) state.slugToContract.set(k, v);
        });
      }
      log("state restored:", "collections=" + state.collections.size, "events=" + state.eventSeen.size);
    } catch (e) {
      log("state load failed", e);
    }
  }

  // ==================== STATS FETCH (priority queue) ====================
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
    score += getMetrics(bestCol, now).hotCount * 100;
    const rec = state.stats.get(slug);
    if (!rec || !rec.fetchedAt) score += 1;
    score -= (now - bestCol.discoveredAt) / 60000;
    return score;
  }

  function heapPush(item) {
    const h = state.fetchHeap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].priority >= h[i].priority) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }

  function heapPop() {
    const h = state.fetchHeap;
    if (!h.length) return null;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      while (true) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let largest = i;
        if (l < n && h[l].priority > h[largest].priority) largest = l;
        if (r < n && h[r].priority > h[largest].priority) largest = r;
        if (largest === i) break;
        [h[i], h[largest]] = [h[largest], h[i]];
        i = largest;
      }
    }
    return top;
  }

  function enqueueStatsFetch(slug) {
    if (!slug || state.statsBroken) return;

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
      for (const item of state.fetchHeap) {
        if (item.slug === slug) { item.priority = priority; break; }
      }
      state.fetchHeap.sort((a, b) => b.priority - a.priority);
    } else {
      state.fetchInQueue.set(slug, true);
      heapPush({ slug, priority, enqueuedAt: now });
    }
    runFetchQueue();
  }

  async function runFetchQueue() {
    if (state.fetching || state.statsBroken) return;
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
        state.brokenStrikes = 0;

        // Reconcile chain with the authoritative GraphQL answer.
        if (parsed && parsed.chainId) {
          const authoritativeCanon = canonicalizeChain(parsed.chainId) || canonicalizeChain(parsed.chainName);
          if (authoritativeCanon) {
            for (const col of [...state.collections.values()]) {
              if (col.slug !== slug || col.chainCanon === authoritativeCanon) continue;
              const parts = col.key.split("::");
              if (parts.length < 3) continue;
              parts[1] = authoritativeCanon;
              migrateCollectionKey(col.key, parts.join("::"), authoritativeCanon, parsed.chainName || col.chainDisplay);
            }
          }
        }
        renderPanel();
      } catch (err) {
        console.warn(LOG_PREFIX, "stats fetch failed for", slug, err);
        const msg = String((err && err.message) || err);
        state.stats.set(slug, { loading: false, ok: false, fetchedAt: Date.now(), error: msg });

        if (/HTTP\s+429\b/.test(msg)) {
          await sleep(CONFIG.rateLimitBackoffMs);
        } else if (isHashBrokenError(msg)) {
          state.brokenStrikes += 1;
          if (state.brokenStrikes >= CONFIG.brokenStrikesLimit) {
            state.statsBroken = { at: Date.now(), reason: msg };
            log("persisted query looks broken, halting stats queue");
            renderPanel();
            break;
          }
        }
      }
      await sleep(CONFIG.fetchGapMs);
    }
    state.fetching = false;
  }

  // Only 400/404 (or explicit PersistedQueryNotFound) mean the hash is stale.
  // 401/403 are Cloudflare/auth hiccups and must NOT disable the extension.
  function isHashBrokenError(msg) {
    return /HTTP\s+(400|404)\b/.test(msg) || /PersistedQueryNotFound/i.test(msg);
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
    if (json && Array.isArray(json.errors) && json.errors.length) {
      throw new Error(json.errors[0].message || "GraphQL error");
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

    const stats = c.stats || {};
    const oneDayVolume = stats.oneDay && stats.oneDay.volume && stats.oneDay.volume.native;
    const mintPrice = c.drop && c.drop.activeDropStage && c.drop.activeDropStage.price
      ? parsePriceObj(c.drop.activeDropStage.price) : null;

    return {
      name: c.name || null,
      isVerified: !!c.isVerified,
      chainName: (c.chain && c.chain.name) || null,
      chainId: (c.chain && c.chain.identifier) || null,
      floor: parsePriceObj(c.floorPrice),
      topOffer: parsePriceObj(c.topOffer),
      mintPrice,
      isMinting: !!(c.drop && c.drop.isMinting),
      maxSupply: (c.drop && c.drop.maxSupply) || null,
      totalSupply: stats.totalSupply || null,
      ownerCount: stats.ownerCount ?? null,
      listedCount: stats.listedItemCount ?? null,
      volume24h: oneDayVolume ? { unit: oneDayVolume.unit, symbol: oneDayVolume.symbol } : null
    };
  }

  // { amount, symbol } | null — always carries the currency.
  function getEffectiveMintPrice(col, stats) {
    if (stats && stats.mintPrice && typeof stats.mintPrice.unit === "number") {
      return { amount: stats.mintPrice.unit, symbol: stats.mintPrice.symbol || "" };
    }
    if (col.lastPrice && typeof col.lastPrice.amount === "number") {
      return { amount: col.lastPrice.amount, symbol: col.lastPrice.unit || "" };
    }
    return null;
  }

  const normSym = (s) => (s || "").toUpperCase().replace(/^WETH$/, "ETH");

  // ==================== FORMATTING ====================
  function formatAgo(ts, now) {
    const t = now || Date.now();
    const s = Math.floor(Math.max(0, t - ts) / 1000);
    if (s < 5) return "now";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function formatUnit(unit, symbol) {
    if (unit === undefined || unit === null) return "—";
    return `${unit} ${symbol || ""}`.trim();
  }

  function formatAmount(p) {
    return p ? `${p.amount} ${p.symbol || ""}`.trim() : "—";
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
    state.panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    state.panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
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
    if (state.panel) {
      const rect = state.panel.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    }
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
  }

  function onWindowResize() {
    if (!state.panel) return;
    const rect = state.panel.getBoundingClientRect();
    applyPosition(rect.left, rect.top);
  }

  // ==================== PANEL ====================
  function createPanel() {
    if (state.panel && document.documentElement.contains(state.panel)) return;
    if (state.panel) removePanel();

    const s = state.settings;
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
          <button class="osmm-btn" data-action="pause" type="button">${state.paused ? "Resume" : "Pause"}</button>
          <button class="osmm-btn" data-action="clear" type="button">Clear</button>
        </div>
        <div class="osmm-controls osmm-controls-compact">
          <label title="How many minutes of history to keep and display">
            window
            <input type="number" min="1" max="1440" step="1" data-setting="windowMinutes" value="${s.windowMinutes}" />
            min
          </label>
          <label title="Show a collection only if it had at least this many mints inside the window">
            min mints
            <input type="number" min="1" max="9999" step="1" data-setting="minMints" value="${s.minMints}" />
          </label>
          <label title="Show a collection only if at least this many distinct wallets minted it (filters one-wallet spam)">
            min minters
            <input type="number" min="1" max="9999" step="1" data-setting="minMinters" value="${s.minMinters}" />
          </label>
        </div>
        <div class="osmm-controls osmm-controls-compact">
          <label class="osmm-check" title="Show only collections that have at least one offer of any size">
            <input type="checkbox" data-setting="onlyWithOffer" ${s.onlyWithOffer ? "checked" : ""} />
            has any offer
          </label>
          <label class="osmm-check" title="Show only collections where the top offer is above the mint price (same currency)">
            <input type="checkbox" data-setting="onlyOfferAboveMint" ${s.onlyOfferAboveMint ? "checked" : ""} />
            offer &gt; mint
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
    lastListHtml = "";

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
      } else if (action === "clear") {
        state.eventSeen.clear();
        state.collections.clear();
        state.pulsed.clear();
        rowMemo = new WeakMap();
        state.dirty = true;
        flushState();
        renderPanel();
        annotateVisibleRows();
      } else if (action === "minimize") {
        panel.classList.toggle("osmm-minimized");
        btn.textContent = panel.classList.contains("osmm-minimized") ? "+" : "–";
      } else if (action === "snap") {
        snapTopRight();
      } else if (action === "toggle-seen") {
        state.settings.seenCollapsed = !state.settings.seenCollapsed;
        saveSettings();
        renderPanel();
      }
    });

    // Checkboxes react instantly; number fields only on commit (change), so
    // typing "120" does not momentarily set window=1 and wipe history.
    panel.addEventListener("input", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "checkbox") applySetting(t);
    });
    panel.addEventListener("change", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "number") applySetting(t);
    });
  }

  function applySetting(target) {
    const setting = target.dataset.setting;
    if (!setting) return;
    if (target.type === "checkbox") {
      state.settings[setting] = !!target.checked;
    } else {
      const v = parseInt(target.value || "1", 10);
      state.settings[setting] = Math.max(1, Number.isFinite(v) ? v : 1);
      target.value = String(state.settings[setting]);
    }
    saveSettings();
    pruneByRetention();
    annotateVisibleRows();
    renderPanel();
  }

  function removePanel() {
    if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
    state.panel = null;
    state.listEl = null;
    state.summaryEl = null;
    state.statusEl = null;
    state.headerEl = null;
    lastListHtml = "";
  }

  // Dim repeated rows / outline hot rows in the native OpenSea feed.
  function annotateVisibleRows() {
    const rows = document.querySelectorAll('[data-osmm-row="1"]');
    const firstByCollection = new Set();
    const now = Date.now();

    rows.forEach((row) => {
      row.classList.remove("osmm-dim-repeat", "osmm-hot-row");
      const key = row.dataset.osmmCollectionKey;
      if (!key) return;
      const col = state.collections.get(key);
      if (!col) return;

      if (getMetrics(col, now).hotCount >= 3) row.classList.add("osmm-hot-row");
      if (firstByCollection.has(key)) row.classList.add("osmm-dim-repeat");
      else firstByCollection.add(key);
    });
  }

  function isCollectionFresh(col, now) {
    return now - col.discoveredAt < CONFIG.freshDurationMs;
  }

  function collectionPassesFilters(col, stats, metrics, now) {
    if (now - col.lastSeen > getRetentionMs()) return false;
    if (metrics.total < state.settings.minMints) return false;
    // minters === 0 means we could not detect wallets — do not penalise.
    if (metrics.minters > 0 && metrics.minters < state.settings.minMinters) return false;

    const offer = stats && stats.topOffer && typeof stats.topOffer.unit === "number" ? stats.topOffer : null;
    const hasAnyOffer = !!(offer && offer.unit > 0);
    if (state.settings.onlyWithOffer && !hasAnyOffer) return false;

    if (state.settings.onlyOfferAboveMint) {
      const mint = getEffectiveMintPrice(col, stats);
      if (!mint || !offer) return false;
      if (mint.symbol && offer.symbol && normSym(mint.symbol) !== normSym(offer.symbol)) return false;
      if (!(offer.unit > mint.amount)) return false;
    }
    return true;
  }

  function renderHeaderSlots() {
    if (!state.panel) return;

    const statusSlot = state.panel.querySelector(".osmm-status-slot");
    if (statusSlot) {
      statusSlot.innerHTML = state.statsBroken ? `
        <a class="osmm-status-badge osmm-status-broken"
           href="${escapeHtml(CONFIG.repoUrl)}" target="_blank" rel="noopener noreferrer"
           title="OpenSea GraphQL rejected our persisted-query hash. The hash likely needs to be updated. Click to open the repo for an updated release.">
          ! outdated. Update required
        </a>` : "";
    }

    const updateSlot = state.panel.querySelector(".osmm-update-slot");
    if (updateSlot) {
      updateSlot.innerHTML = state.updateAvailable ? `
        <a class="osmm-update-badge"
           href="${escapeHtml(state.updateAvailable.url)}"
           target="_blank" rel="noopener noreferrer"
           title="New version ${escapeHtml(state.updateAvailable.latestVersion)} available (installed ${escapeHtml(getInstalledVersion())})">
          ↑ new version
        </a>` : "";
    }
  }

  function setListHtml(html) {
    if (html === lastListHtml) return;
    const st = state.listEl.scrollTop;
    state.listEl.innerHTML = html;
    state.listEl.scrollTop = st;
    lastListHtml = html;
  }

  function renderPanel() {
    if (!state.panel || !state.listEl) return;

    renderHeaderSlots();

    const now = Date.now();
    const retention = getRetentionMs();
    const newCards = [];
    const seenCards = [];

    for (const col of state.collections.values()) {
      const statsRec = col.slug ? state.stats.get(col.slug) : null;
      const stats = statsRec && statsRec.ok ? statsRec.data : null;
      const metrics = getMetrics(col, now);
      if (!collectionPassesFilters(col, stats, metrics, now)) continue;
      (state.seen.has(col.key) ? seenCards : newCards).push({ col, stats, statsRec, metrics });
    }

    newCards.sort((a, b) => b.col.discoveredAt - a.col.discoveredAt);
    seenCards.sort((a, b) => b.col.lastSeen - a.col.lastSeen);

    // Keep floor/offer fresh for what is actually on screen in the NEW section
    // (enqueue is gated by statsRefreshMs, so this is cheap).
    for (const c of newCards) if (c.col.slug) enqueueStatsFetch(c.col.slug);

    state.summaryEl.innerHTML = `
      <strong>${newCards.length}</strong> new · <strong>${seenCards.length}</strong> seen ·
      window <strong>${Math.round(retention / 60000)}m</strong>
    `;
    state.statusEl.textContent = state.paused
      ? "paused"
      : `live · last scan ${state.lastScanAt ? formatAgo(state.lastScanAt, now) : "now"} ago · fetch queue: ${state.fetchHeap.length}`;

    if (!newCards.length && !seenCards.length) {
      setListHtml(`
        <div class="osmm-empty">
          Nothing matches the current filters.<br>
          Try lowering "min mints" / "min minters" or turning off the offer filters.
        </div>
      `);
      return;
    }

    const parts = [];
    parts.push(`
      <div class="osmm-section-header">
        <span>NEW <span class="osmm-section-count">${newCards.length}</span></span>
        <span class="osmm-section-toggle">freshest first</span>
      </div>
    `);
    parts.push(newCards.length
      ? newCards.map((c) => renderCard(c, now, false)).join("")
      : `<div class="osmm-empty">No unseen collections right now.</div>`);

    if (seenCards.length) {
      parts.push(`
        <div class="osmm-section-header" data-action="toggle-seen">
          <span>SEEN <span class="osmm-section-count">${seenCards.length}</span></span>
          <span class="osmm-section-toggle">${state.settings.seenCollapsed ? "show" : "hide"}</span>
        </div>
      `);
      if (!state.settings.seenCollapsed) {
        parts.push(seenCards.map((c) => renderCard(c, now, true)).join(""));
      }
    }

    setListHtml(parts.join(""));
  }

  function renderCard({ col, stats, statsRec, metrics }, now, isSeen) {
    const fresh = !isSeen && isCollectionFresh(col, now);
    const justArrived = fresh && !state.pulsed.has(col.key);
    if (justArrived) state.pulsed.add(col.key);

    const classes = ["osmm-card"];
    if (fresh) classes.push("osmm-card-fresh");
    if (isSeen) classes.push("osmm-card-seen");
    if (justArrived) classes.push("osmm-card-just-arrived");

    const targetUrl = col.collectionUrl || col.itemUrl || null;
    const verified = stats && stats.isVerified ? `<span class="osmm-verified" title="Verified">✓</span>` : "";
    const newBadge = fresh ? `<span class="osmm-badge-new">NEW</span>` : "";

    const floorStr = stats && stats.floor ? escapeHtml(formatUnit(stats.floor.unit, stats.floor.symbol))
      : (statsRec && statsRec.loading ? '<span class="osmm-loading">loading…</span>' : "—");
    const offerStr = stats && stats.topOffer ? escapeHtml(formatUnit(stats.topOffer.unit, stats.topOffer.symbol)) : "—";
    const volStr = stats && stats.volume24h ? escapeHtml(formatUnit(stats.volume24h.unit, stats.volume24h.symbol)) : "—";
    const itemsStr = stats && (stats.totalSupply || stats.maxSupply)
      ? escapeHtml(`${stats.totalSupply || "?"}${stats.maxSupply ? " / " + stats.maxSupply : ""}`) : "—";
    const ownersStr = stats && stats.ownerCount !== null && stats.ownerCount !== undefined ? escapeHtml(String(stats.ownerCount)) : "—";
    const mintingBadge = stats && stats.isMinting ? " · <b>minting</b>" : "";
    const mintPriceStr = escapeHtml(formatAmount(getEffectiveMintPrice(col, stats)));
    const chainDisplay = (stats && stats.chainName) || col.chainDisplay || "Unknown";
    const mintersStr = metrics.minters > 0 ? String(metrics.minters) : "?";

    const linkHtml = targetUrl
      ? `<a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer"
           data-role="open-collection" data-collection-key="${escapeHtml(col.key)}">open collection</a>`
      : `<span class="osmm-loading">no link</span>`;

    return `
      <div class="${classes.join(" ")}">
        <div class="osmm-card-top">
          <div class="osmm-name">${escapeHtml(col.name || "Unknown")}${verified}${newBadge}</div>
          <div class="osmm-chain">${escapeHtml(chainDisplay)}</div>
        </div>
        <div class="osmm-metrics">
          <span>1m: <b>${metrics.hotCount}</b></span>
          <span>total: <b>${metrics.total}</b></span>
          <span>minters: <b>${mintersStr}</b></span>${mintingBadge}
        </div>
        <div class="osmm-stats">
          <span>mint: <b>${mintPriceStr}</b></span>
          <span>floor: <b>${floorStr}</b></span>
          <span>offer: <b>${offerStr}</b></span>
        </div>
        <div class="osmm-meta">
          <span>24h vol: <b>${volStr}</b></span>
          <span>items: <b>${itemsStr}</b></span>
          <span>owners: <b>${ownersStr}</b></span>
          <span>last: <b>${escapeHtml(formatAgo(col.lastSeen, now))}</b></span>
        </div>
        <div class="osmm-links">${linkHtml}</div>
      </div>
    `;
  }

  // ==================== SCAN LOOP ====================
  function scanPage() {
    if (state.paused || !isActivityPage()) return;
    if (!state.panel || !document.documentElement.contains(state.panel)) createPanel();

    const txt = makeTextCache();
    const rows = collectRowCandidates(txt);

    for (const row of rows) {
      const meta = extractEventMeta(row, txt);
      if (!meta) continue;

      row.dataset.osmmRow = "1";
      row.dataset.osmmCollectionKey = meta.collectionKey;

      // Same DOM node, same event — it only aged. Skip.
      const prev = rowMemo.get(row);
      if (prev === meta.baseKey) continue;
      rowMemo.set(row, meta.baseKey);

      if (state.eventSeen.has(meta.eventKey)) continue;
      state.eventSeen.set(meta.eventKey, meta.seenAt);
      addEvent(meta);
    }

    mergeSlugKeyedDuplicates();
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
    if (state.observer || !document.body) return;
    state.observer = new MutationObserver(() => {
      if (state.paused) return;
      scheduleScanSoon();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  // ==================== LIFECYCLE ====================
  function initOnce() {
    if (initialized) return;
    initialized = true;
    loadSettings();
    loadSeen();
    loadState();

    window.addEventListener("resize", onWindowResize);
    window.addEventListener("pagehide", flushState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushState();
    });
  }

  function start() {
    initOnce();
    createPanel();
    attachObserver();
    if (!state.scanTimerId) state.scanTimerId = setInterval(scanPage, CONFIG.scanIntervalMs);
    if (!state.saveTimerId) state.saveTimerId = setInterval(flushState, CONFIG.stateSaveIntervalMs);
    checkForUpdate();
    scanPage();
  }

  function stop() {
    if (state.scanTimerId) { clearInterval(state.scanTimerId); state.scanTimerId = 0; }
    if (state.saveTimerId) { clearInterval(state.saveTimerId); state.saveTimerId = 0; }
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    flushState();
    removePanel();
  }

  function isActivityPage() {
    return location.pathname === "/activity" || location.pathname === "/activity/";
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
      if (!state.scanTimerId) start();
      else setTimeout(scanPage, 500);
    } else if (state.scanTimerId || state.panel) {
      log("left /activity, stopping");
      stop();
    }
  }, 1000);

  boot();
})();