package api

import (
	"context"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"doujinshi-manager/internal/downloader"
	"doujinshi-manager/internal/models"
)

func setDownloaderCurrentProgressForTest(t *testing.T, manager *downloader.Manager, progress *models.DownloadProgress) {
	t.Helper()

	field := reflect.ValueOf(manager).Elem().FieldByName("currentProgress")
	reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().Set(reflect.ValueOf(progress))
}

func TestHandleDownloadProgress_SendsCurrentSnapshotImmediately(t *testing.T) {
	s := newTestServer(t)
	s.downloader = downloader.NewManager(nil, nil, nil, nil)
	setDownloaderCurrentProgressForTest(t, s.downloader, &models.DownloadProgress{
		GalleryID:   "123456",
		Title:       "Snapshot Title",
		CurrentPage: 4,
		TotalPages:  10,
		Percentage:  40,
		Status:      "downloading",
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequest("GET", "/api/download/progress", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})

	go func() {
		s.handleDownloadProgress(rec, req)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("progress handler did not exit after cancellation")
	}

	body := rec.Body.String()
	if !strings.Contains(body, "Snapshot Title") {
		t.Fatalf("expected current snapshot to be sent immediately, got %q", body)
	}
}
