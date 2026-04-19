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
