package database

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB wraps the shared SQLite database handle.
type DB struct {
	*sql.DB
}

// NewDB opens the SQLite database, applies pragmas, and runs migrations.
func NewDB(dbPath string) (*DB, error) {
	// Ensure directory exists
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// SQLite in WAL mode behaves best with a single writer connection.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	if _, err := db.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA synchronous = NORMAL;
	`); err != nil {
		return nil, fmt.Errorf("failed to configure database pragmas: %w", err)
	}

	// Run migrations
	if err := runMigrations(db); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return &DB{db}, nil
}

func runMigrations(db *sql.DB) error {
	schema := `
CREATE TABLE IF NOT EXISTS owned (
    id          TEXT PRIMARY KEY,
    media_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT,
    added_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    artist      TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id  TEXT NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_owned_media_id ON owned(media_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
`

	if _, err := db.Exec(schema); err != nil {
		return err
	}

	return nil
}
