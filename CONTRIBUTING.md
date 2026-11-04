# Contributing

Thanks for your interest! This is a small, dependency-light project and aims to stay that way.

## Project layout

```
server.js            # the whole backend (Express + JSON-file storage)
public/
  index.html         # the whole front end (vanilla JS, no build step)
  vendor/            # qrcode-generator + jsPDF (vendored, pinned)
  manifest.json, sw.js, icon-*.png
Dockerfile, docker-compose.yml
.github/workflows/release.yml   # auto-builds the Windows .exe on a v* tag
```

There is **no build step** for the app itself — edit `server.js` or `public/index.html` and reload.

## Running locally

```bash
npm install
DATA_DIR=./data PORT=8095 npm start
# open http://localhost:8095
```

## Before opening a PR

- Keep it dependency-light. The front end is intentionally framework-free.
- `node --check server.js` and make sure the page loads with no console errors.
- Describe what you changed and how you tested it.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and your setup (Docker / Node / exe, OS, browser).
