package database

import (
	"database/sql"
	"log"
	"strings"
	"time"

	"doujinshi-manager/internal/models"
)

func isBusyError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "database is locked") || strings.Contains(message, "sqlite_busy")
}

func (db *DB) execWithRetry(query string, args ...interface{}) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		_, err = db.Exec(query, args...)
		if err == nil {
			return nil
		}
		if !isBusyError(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
	}
	return err
}

func (db *DB) withTransaction(fn func(tx *sql.Tx) error) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		var tx *sql.Tx
		tx, err = db.Begin()
		if err != nil {
			if !isBusyError(err) {
				return err
			}
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
			continue
		}

		if err = fn(tx); err != nil {
			_ = tx.Rollback()
			if !isBusyError(err) {
				return err
			}
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
			continue
		}

		err = tx.Commit()
		if err == nil {
			return nil
		}
		_ = tx.Rollback()
		if !isBusyError(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
	}
	return err
}

// Owned operations
func (db *DB) InsertOwned(entry *models.OwnedEntry) error {
	return db.execWithRetry(`
		INSERT INTO owned (id, media_id, title, artist, added_at)
		VALUES (?, ?, ?, ?, ?)`,
		entry.ID, entry.MediaID, entry.Title, entry.Artist, entry.AddedAt)
}

func (db *DB) InsertOwnedBatch(entries []*models.OwnedEntry) error {
	if len(entries) == 0 {
		return nil
	}

	return db.withTransaction(func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT INTO owned (id, media_id, title, artist, added_at)
			VALUES (?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for _, entry := range entries {
			if _, err := stmt.Exec(entry.ID, entry.MediaID, entry.Title, entry.Artist, entry.AddedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (db *DB) GetOwnedByID(id string) (*models.OwnedEntry, error) {
	var entry models.OwnedEntry
	err := db.QueryRow(`
		SELECT id, media_id, title, artist, added_at
		FROM owned WHERE id = ?`, id).Scan(
		&entry.ID, &entry.MediaID, &entry.Title, &entry.Artist, &entry.AddedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &entry, err
}

func (db *DB) GetOwnedByMediaID(mediaID string) (*models.OwnedEntry, error) {
	log.Printf("[DB] GetOwnedByMediaID query for: %s", mediaID)
	var entry models.OwnedEntry
	err := db.QueryRow(`
		SELECT id, media_id, title, artist, added_at
		FROM owned WHERE media_id = ?`, mediaID).Scan(
		&entry.ID, &entry.MediaID, &entry.Title, &entry.Artist, &entry.AddedAt)
	if err == sql.ErrNoRows {
		log.Printf("[DB] GetOwnedByMediaID(%s): NOT FOUND", mediaID)
		return nil, nil
	}
	if err != nil {
		log.Printf("[DB] GetOwnedByMediaID(%s): ERROR: %v", mediaID, err)
		return nil, err
	}
	log.Printf("[DB] GetOwnedByMediaID(%s): FOUND - ID=%s, Title=%s", mediaID, entry.ID, entry.Title)
	return &entry, err
}

func (db *DB) CountOwned() (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM owned").Scan(&count)
	return count, err
}

func (db *DB) ListOwned(limit, offset int) ([]models.OwnedEntry, error) {
	rows, err := db.Query(`
		SELECT id, media_id, title, artist, added_at
		FROM owned ORDER BY added_at DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []models.OwnedEntry
	for rows.Next() {
		var entry models.OwnedEntry
		if err := rows.Scan(&entry.ID, &entry.MediaID, &entry.Title, &entry.Artist, &entry.AddedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (db *DB) ListOwnedIDs() ([]string, error) {
	rows, err := db.Query(`SELECT id FROM owned ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// Queue operations
func (db *DB) InsertQueue(entry *models.QueueEntry) error {
	return db.execWithRetry(`
		INSERT OR IGNORE INTO queue (id, title, artist, status, error, added_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.Title, entry.Artist, entry.Status, entry.Error, entry.AddedAt, entry.UpdatedAt)
}

func (db *DB) InsertQueueBatch(entries []*models.QueueEntry) error {
	if len(entries) == 0 {
		return nil
	}

	return db.withTransaction(func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT OR IGNORE INTO queue (id, title, artist, status, error, added_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for _, entry := range entries {
			if _, err := stmt.Exec(entry.ID, entry.Title, entry.Artist, entry.Status, entry.Error, entry.AddedAt, entry.UpdatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (db *DB) UpdateQueueStatus(id string, status models.GalleryStatus, errorMsg string) error {
	return db.execWithRetry(`
		UPDATE queue SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
		status, errorMsg, time.Now(), id)
}

func (db *DB) GetQueueByID(id string) (*models.QueueEntry, error) {
	var entry models.QueueEntry
	err := db.QueryRow(`
		SELECT id, title, artist, status, error, added_at, updated_at
		FROM queue WHERE id = ?`, id).Scan(
		&entry.ID, &entry.Title, &entry.Artist, &entry.Status, &entry.Error, &entry.AddedAt, &entry.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &entry, err
}

func (db *DB) UpdateQueueMetadata(id, title, artist string) error {
	return db.execWithRetry(`
		UPDATE queue SET title = ?, artist = ?, updated_at = ? WHERE id = ?`,
		title, artist, time.Now(), id)
}

func (db *DB) ListQueue(statusFilter models.GalleryStatus) ([]models.QueueEntry, error) {
	var rows *sql.Rows
	var err error
	if statusFilter != "" {
		rows, err = db.Query(`
			SELECT id, title, artist, status, error, added_at, updated_at
			FROM queue WHERE status = ? ORDER BY added_at ASC`, statusFilter)
	} else {
		rows, err = db.Query(`
			SELECT id, title, artist, status, error, added_at, updated_at
			FROM queue ORDER BY added_at ASC`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []models.QueueEntry
	for rows.Next() {
		var entry models.QueueEntry
		if err := rows.Scan(&entry.ID, &entry.Title, &entry.Artist, &entry.Status, &entry.Error, &entry.AddedAt, &entry.UpdatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (db *DB) DeleteQueue(id string) error {
	return db.execWithRetry("DELETE FROM queue WHERE id = ?", id)
}

func (db *DB) ClearQueue() error {
	return db.execWithRetry("DELETE FROM queue")
}

func (db *DB) CountQueue() (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM queue").Scan(&count)
	return count, err
}

func (db *DB) CountQueueByStatus(status models.GalleryStatus) (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM queue WHERE status = ?", status).Scan(&count)
	return count, err
}

// History operations
func (db *DB) InsertHistory(entry *models.HistoryEntry) error {
	return db.execWithRetry(`
		INSERT INTO history (gallery_id, status, error, timestamp)
		VALUES (?, ?, ?, ?)`,
		entry.GalleryID, entry.Status, entry.Error, entry.Timestamp)
}

func (db *DB) ListHistory(limit, offset int) ([]models.HistoryEntry, error) {
	rows, err := db.Query(`
		SELECT id, gallery_id, status, error, timestamp
		FROM history ORDER BY timestamp DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []models.HistoryEntry
	for rows.Next() {
		var entry models.HistoryEntry
		if err := rows.Scan(&entry.ID, &entry.GalleryID, &entry.Status, &entry.Error, &entry.Timestamp); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}
