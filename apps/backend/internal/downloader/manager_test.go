package downloader

import (
	"testing"
	"time"

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
