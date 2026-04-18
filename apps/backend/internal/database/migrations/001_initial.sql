-- Migration 001_initial.sql

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
    -- pending | downloading | done | failed | duplicate
    error       TEXT,
    added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id  TEXT NOT NULL,
    status      TEXT NOT NULL,   -- success | failed
    error       TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_owned_media_id ON owned(media_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);