# db-client Database Client Plugin

A compact pi-web-ui database client inspired by [vscode-database-client](https://github.com/cweijan/vscode-database-client): manage connections, browse database trees and schemas, page through data, and run SQL queries.

## Supported databases

| Database        | Driver                 | Default port | Features                                                                                                                          |
| --------------- | ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| MySQL / MariaDB | mysql2                 | 3306         | Databases, tables, views, columns, indexes, DDL, pagination, sorting, and SQL                                                     |
| PostgreSQL      | pg                     | 5432         | Public-schema tables, materialized views, views, primary keys, indexes, cross-database browsing, and SQL                          |
| SQLite          | node:sqlite (built in) | File path    | Local .db files, no extra driver, PRAGMA schema, pagination, SQL, and row editing (Node >= 22.13)                                 |
| SQL Server      | mssql                  | 1433         | Schema detection, OFFSET/FETCH pagination, and SQL                                                                                |
| MongoDB         | mongodb                | 27017        | Database and collection tree, paginated documents with JSON filters such as `{"age":{"$gt":18}}`, and indexes; SQL is unsupported |
| Redis           | ioredis                | 6379         | Pattern-scanned keys, key details (type, TTL, size, and value preview), and raw commands                                          |

Driver dependencies are **not bundled**. First activation installs them into the plugin directory with `npm install`; use the sidebar's **Install drivers** button to start that install manually. Connections whose driver is available continue to work when only some drivers are installed.

## Install, update, and uninstall

```bash
# Install the catalog-sync selector
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync
# Open catalog-sync, select this plugin, and choose "Update selected plugins"
# Local development: build this plugin before installing its directory
npm run build:db-client
pi-web-ui install plugins/db-client
# Optional: --data-dir <dir> selects a data directory (default: ~/.pi-web)

# Inspect installed plugins
pi-web-ui plugins

# Select this plugin in catalog-sync to rebuild and reinstall it, or rebuild locally.
# Back up db-connections.json in the plugin directory first.

# Uninstall (also deletes db-connections.json)
pi-web-ui uninstall db-client
# Or: rm -rf ~/.pi-web/plugins/db-client
```

Refresh the browser after installation; the Database Client tab appears in the top bar.

## Features

- **Connection management:** create, edit, delete, and test connections. Credentials stay local in `<dataDir>/plugins/db-client/db-connections.json` and are redacted when displayed.
- **Multiple active connections:** up to 8 simultaneous connections, each isolated with disconnect notices.
- **Data browsing:** first/previous/next/last pagination, sortable columns, subdued NULL values, and row counts.
- **Schema browsing:** columns, nullability, primary keys, defaults, notes, indexes, and DDL.
- **SQL editor:** Ctrl/Cmd+Enter runs a query and displays timing, affected rows, and tabular results.
- **MongoDB:** browse collections and page documents using JSON filters.
- **Row editing:** double-click to edit, Enter to save, Escape to cancel, delete rows, and add rows. SQLite tables without a primary key use `rowid`; uppercase NULL writes SQL NULL.
- **MongoDB editing:** edit, delete, and add JSON documents; hexadecimal `_id` values are restored as ObjectIds.
- **Redis editing:** save string key values in place.
- **Redis tools:** scan patterns, inspect TTL and type, render string/hash/list/set/zset/stream values, and run raw commands.

## Protocol

Upstream messages use `{ action, reqId, ... }`; responses use `{ res: true, reqId, ok, ... }` and match `reqId`. `{ event: "conn_closed", ... }` is targeted to its connection owner and `{ kind: "state", state }` broadcasts state.

## Regression tests

```bash
npm test -- tests/unit/db-client.test.ts
```
