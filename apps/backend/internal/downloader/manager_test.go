package downloader

import (
	"path/filepath"
	"testing"
	"time"

	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/models"
)

func TestPublishProgressIncludesBatchElapsed(t *testing.T) {
	m := &Manager{
		progress: make(chan models.DownloadProgress, 1),
	}
	m.batchStartedAt = time.Now().Add(-3 * time.Second)

	m.publishProgress(models.DownloadProgress{
		GalleryID:   "123",
		Title:       "Example",
		CurrentPage: 1,
		TotalPages:  10,
		Percentage:  10,
		Status:      "downloading",
	})

	select {
	case progress := <-m.progress:
		if progress.BatchElapsedMs < 2500 {
			t.Fatalf("expected published batch timer to be populated, got %dms", progress.BatchElapsedMs)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a published progress event")
	}
}

func TestProgressSubscribersReceiveSameEvent(t *testing.T) {
	m := &Manager{
		progress: make(chan models.DownloadProgress, 2),
	}

	first := m.Progress()
	second := m.Progress()

	event := models.DownloadProgress{
		GalleryID:   "999",
		Title:       "Broadcast",
		CurrentPage: 3,
		TotalPages:  9,
		Percentage:  33,
		Status:      "downloading",
	}
	m.publishProgress(event)

	select {
	case got := <-first:
		if got.GalleryID != event.GalleryID {
			t.Fatalf("first subscriber got wrong event: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first subscriber did not receive progress")
	}

	select {
	case got := <-second:
		if got.GalleryID != event.GalleryID {
			t.Fatalf("second subscriber got wrong event: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second subscriber did not receive progress")
	}
}

func TestPauseDownloadsKeepsQueuedEntriesPending(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := database.NewDB(dbPath)
	if err != nil {
		t.Fatalf("failed to create test db: %v", err)
	}
	defer db.Close()

	m := &Manager{
		db:           db,
		jobCh:        make(chan string, 4),
		scheduledIDs: make(map[string]struct{}),
	}

	now := time.Now()
	for _, id := range []string{"111", "222"} {
		if err := db.InsertQueue(&models.QueueEntry{
			ID:        id,
			Status:    models.StatusPending,
			AddedAt:   now,
			UpdatedAt: now,
		}); err != nil {
			t.Fatalf("failed to insert queue entry %s: %v", id, err)
		}
		m.jobCh <- id
		m.scheduledIDs[id] = struct{}{}
	}

	paused := m.PauseDownloads()
	if paused != 2 {
		t.Fatalf("expected two paused entries, got %d", paused)
	}

	entries, err := db.ListQueue(models.StatusPending)
	if err != nil {
		t.Fatalf("failed to list pending queue after pause: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected queued entries to remain pending after pause, got %d", len(entries))
	}

	if len(m.scheduledIDs) != 0 {
		t.Fatalf("expected scheduled ids to be cleared after pause, got %d", len(m.scheduledIDs))
	}
}
