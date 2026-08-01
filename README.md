# OpenSea Mint Monitor

A Chrome extension that turns the OpenSea live activity feed into a **collection-grouped mint radar** — right on top of the page.

Instead of watching hundreds of individual NFTs scroll past, you see a compact side panel with:

- collections currently being minted, grouped so you never see the same drop twice
- a **NEW** section that always shows freshly discovered collections at the top
- a **SEEN** section for collections you already opened (moved automatically on click)
- **live floor price and top offer** pulled from OpenSea's own GraphQL API
- filters to keep only collections that already have offers

The panel is draggable, always on top, and its history survives page refreshes.

## Screenshots

<img width="1860" height="525" alt="image" src="https://github.com/user-attachments/assets/91d610f5-1ada-498a-8c58-bf02f0fd4c7e" />

## Why

The default OpenSea activity page (`/activity?activityTypes=mint`) shows a fast-scrolling stream of individual NFTs. It's impossible to spot _which collection_ is being minted right now, and it's very easy to miss a fresh drop in the noise.

This extension solves that without leaving the OpenSea page.

## Features

- **Collection grouping** — no more scrolling through hundreds of `#1234` mints of the same collection.
- **NEW / SEEN sections** — freshly discovered collections stay at the top of NEW. As soon as you click "open collection", the card moves into SEEN, so what you have not looked at yet is always front and center.
- **NEW badge and pulse** — brand-new collections get a blue border, a `NEW` badge and a short one-time pulse for 60 seconds after discovery.
- **Persistent history** — configurable retention window (default 60 minutes); data and your "seen" list survive `F5`.
- **Live floor and top offer** — pulled from the same OpenSea GraphQL endpoint the site uses for its hover tooltips.
- **Offer filters** — `has any offer` (collection has at least one offer > 0) and `offer > mint` (top offer is above the mint price).
- **Multi-chain** — works with every chain OpenSea displays: Ethereum, Base, Polygon, Arbitrum, Robinhood Chain, and others.
- **Draggable panel** — position is saved between sessions.
- **No API key required** — reuses your existing OpenSea session cookies.

## Installation

The extension is not published to the Chrome Web Store yet. Install it as an unpacked extension:

1. Download this repository as a ZIP (green **Code** button → **Download ZIP**) and unzip it,
   or clone it:
   ```bash
   git clone https://github.com/NazarovEmil/opensea-mint-monitor.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top right corner)
4. Click **Load unpacked** and select the extension folder
5. Open [opensea.io/activity?activityTypes=mint&markets=opensea](https://opensea.io/activity?activityTypes=mint&markets=opensea)
6. The panel appears in the top-right corner. Drag it wherever you like.

## Usage

The panel has three number controls:

| Control | What it does |
|---|---|
| **window** | How many minutes of history to keep. A collection is dropped if it had no mints in this window. |
| **min mints** | Show a collection only if it had at least this many mints inside the window. |

Two independent offer toggles:

- **has any offer** — hide collections without a single active offer. Useful because a collection with any real bid is more likely to be interesting than one with none.
- **offer > mint** — hide everything except collections where the current top offer is higher than the mint price. Rare, but very useful when it happens.

Each card shows:

- **1m / total** — mints in the last minute / total mints inside the window.
- **mint / floor / offer** — current prices from OpenSea.
- **24h vol / items / owners** — collection health signals.

Cards are grouped into two sections:

- **NEW** — collections you have not opened yet. Freshest at the top.
- **SEEN** — collections where you already clicked "open collection". Click the SEEN header to hide or show this section.

Collections discovered less than 60 seconds ago get a blue border, a `NEW` badge and pulse once — so you notice them even if you were looking somewhere else on the page.

## How it works

- A `MutationObserver` watches OpenSea's activity feed for new rows and parses collection name, chain, mint price and timestamp from the DOM.
- Events are stored in `localStorage`, so page refreshes never lose history inside the retention window.
- For each new collection the extension calls OpenSea's public GraphQL endpoint (`gql.opensea.io`) using the same persisted query (`CollectionPreviewTooltipContentQuery`) that the site uses when you hover over a collection. This returns floor price, top offer, 24h volume, supply and owner counts.
- Fetches are rate-limited to at most ~2.5 req/sec per collection and cached for 2 minutes.
- The list of collections you have already opened is stored separately and kept for a week, so a collection you looked at 3 days ago will not resurface as "new" if it mints again today.

Everything runs entirely in the browser. No servers, no API keys, no tracking.

## Project structure

```
opensea-mint-monitor/
├── manifest.json    # Chrome extension manifest (v3)
├── content.js       # Main logic: DOM parsing, storage, GraphQL, UI
├── content.css      # Styles for the floating panel
├── README.md        # This file
└── LICENSE          # MIT
```

## Known limitations

- **OpenSea layout changes** may break DOM parsing. If the panel stops picking up mints, open DevTools (F12) → Console — you will see `[OSMM] scan:` logs indicating whether rows are being found.
- **GraphQL hash** — OpenSea's persisted-query hash for the tooltip may change over time. If floor/offer data stops loading, the hash needs to be updated in `content.js` under `CONFIG.tooltipQueryHash`. To find the new hash: open DevTools → Network → hover any collection → find the `CollectionPreviewTooltipContentQuery` request and copy the `sha256Hash` from its URL.
- The extension currently reads only what OpenSea itself renders and exposes via its own API. It does not query blockchains directly.

## Roadmap ideas

- Desktop notifications for freshly discovered collections
- CSV export of tracked collections
- Firefox port
- Options page for advanced filters (per-chain blocklist, name blocklist for scams, etc.)
- Configurable persisted-query hash via the options page (so users can fix it without editing code)

## Contributing

Issues and pull requests are welcome. If you notice OpenSea has changed something and the extension stops working, please open an issue with:

- what stopped working
- browser version
- a screenshot of the DevTools Console with `[OSMM]` logs

## Disclaimer

This is an unofficial third-party tool. It is not affiliated with, endorsed by, or sponsored by OpenSea. Use at your own risk. It only reads data that the OpenSea website itself already sends to your browser.

Nothing shown by this extension is financial advice.

## License

MIT — see [LICENSE](LICENSE).
