# OpenSea Mint Monitor

A Chrome extension that turns the OpenSea live activity feed into a **collection-grouped mint radar** with live floor price, top offer and profit deltas — right on top of the page.

Instead of watching hundreds of individual NFTs scroll past, you see a compact side panel with:

- collections currently being minted
- how many mints happened in the last minute and inside your chosen time window
- **live floor price and top offer** pulled from OpenSea's own GraphQL API
- **Δ floor / Δ offer** — how much the floor price is above the mint price (the actual flip profit)
- filters to show only collections where `floor > mint` or `top offer > mint`

The panel is draggable, always on top, and its history survives page refreshes.

## Screenshots

<img width="1526" height="855" alt="image" src="https://github.com/user-attachments/assets/20828104-7894-4da2-887e-65363f46bf7a" />



## Why

The default OpenSea activity page (`/activity?activityTypes=mint`) shows a fast-scrolling stream of individual NFTs. It's impossible to spot _which collection_ is being minted right now, and there is no way to filter for the only thing that matters when flipping mints: **is the floor price already above the mint price?**

This extension solves both problems without leaving the OpenSea page.

## Features

- **Collection grouping** — no more scrolling through hundreds of `#1234` mints of the same collection.
- **Persistent history** — configurable retention window (default 60 minutes); data survives `F5`.
- **Live floor and top offer** — pulled from the same OpenSea GraphQL endpoint the site uses for its hover tooltips.
- **Profit filters** — show only collections where floor / top offer exceed the mint price by X%.
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

The panel has three main controls:

| Control | What it does |
|---|---|
| **window** | How many minutes of history to keep. A collection is dropped if it had no mints in this window. |
| **min mints** | Show a collection only if it had at least this many mints inside the window. |
| **profit ≥** | Threshold in percent for the "profitable" filters and for the green highlight. |

Two toggles:

- **only floor > mint** — hide everything except collections where the floor price is already above the mint price by `profit ≥ N%`.
- **only offer > mint** — hide everything except collections that already have an offer higher than the mint price.

Each card shows:

- **1m / total** — mints in the last minute / total mints inside the window.
- **mint / floor / offer** — current prices.
- **Δ floor / Δ offer** — percentage difference between floor/offer and the mint price. Green = profit, red = loss.
- **24h vol / items / owners** — collection health signals.

Profitable collections (`Δ floor ≥ profit ≥`) are highlighted green and sorted to the top.

## How it works

- A `MutationObserver` watches OpenSea's activity feed for new rows and parses collection name, chain, mint price and timestamp from the DOM.
- Events are stored in `localStorage`, so page refreshes never lose history inside the retention window.
- For each new collection the extension calls OpenSea's public GraphQL endpoint (`gql.opensea.io`) using the same persisted query (`CollectionPreviewTooltipContentQuery`) that the site uses when you hover over a collection. This returns floor price, top offer, 24h volume, supply and owner counts.
- Fetches are rate-limited to ~2.5 req/sec and cached for 2 minutes per collection.

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

- Sound / desktop notifications for high-profit mints
- CSV export of tracked collections
- Firefox port
- Options page for advanced filters (per-chain thresholds, blocklist, etc.)
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
