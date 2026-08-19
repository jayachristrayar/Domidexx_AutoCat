# AutoCat

AutoCat is a browser extension and backend for librarians. A librarian logs into the extension, enters an ISBN, and the backend generates a MARC 21 record following the institution's cataloguing rules (AACR2 + ISBD + local practice). The librarian can refine the record via a chat panel, then auto-fill the result into Koha's cataloguing web editor via a content script. The extension stores only an opaque session token locally; all draft records, chat history, and UI state live server-side in Postgres.

## Repository structure

```
backend/
  package.json              Express API dependencies
  src/server.js             Express app entry point
  src/db/index.js           Postgres connection pool
  src/db/schema.sql         Database schema
  .env.example              Environment variable template
  rules/                    Institution cataloguing rule PDFs + parsed JSON (placeholder)

extension/
  package.json              Extension build dependencies
  manifest.json             WebExtension manifest (MV3)
  src/background/           Service worker
  src/popup/                Extension popup UI
  src/chat/                 Chat panel (placeholder)
  src/content-scripts/      Koha auto-fill content script
  src/lib/                  Shared client utilities (API client)

assets/logo/                Logo files for extension icons (placeholder)
```
