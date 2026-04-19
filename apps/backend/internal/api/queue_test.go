package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/models"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := database.NewDB(dbPath)
	if err != nil {
		t.Fatalf("failed to create test db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	return &Server{db: db}
}

func TestHandleEnqueue_InsertsPendingWithoutMetadata(t *testing.T) {
	s := newTestServer(t)

	body, err := json.Marshal(map[string][]string{
		"ids": {"123456", "234567"},
	})
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/queue", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	s.handleEnqueue(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	entries, err := s.db.ListQueue("")
	if err != nil {
		t.Fatalf("failed to list queue: %v", err)
	}

	if len(entries) != 2 {
		t.Fatalf("expected 2 queued entries, got %d", len(entries))
	}

	for _, entry := range entries {
		if entry.Status != models.StatusPending {
			t.Fatalf("expected pending status for %s, got %s", entry.ID, entry.Status)
		}
		if entry.Title != "" {
			t.Fatalf("expected empty title for %s, got %q", entry.ID, entry.Title)
		}
		if entry.Artist != "" {
			t.Fatalf("expected empty artist for %s, got %q", entry.ID, entry.Artist)
		}
	}
}

func TestHandleEnqueue_SkipsOwnedAndExistingQueueEntries(t *testing.T) {
	s := newTestServer(t)

	err := s.db.InsertOwned(&models.OwnedEntry{
		ID:      "111111",
		MediaID: "media-111111",
		Title:   "Owned",
		Artist:  "Artist",
		AddedAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("failed to insert owned entry: %v", err)
	}

	err = s.db.InsertQueue(&models.QueueEntry{
		ID:        "222222",
		Status:    models.StatusPending,
		AddedAt:   time.Now(),
		UpdatedAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("failed to insert queue entry: %v", err)
	}

	body, err := json.Marshal(map[string][]string{
		"ids": {"111111", "222222", "333333"},
	})
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/queue", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	s.handleEnqueue(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if response["added"] != 1 {
		t.Fatalf("expected added=1, got %d", response["added"])
	}
	if response["skipped_owned"] != 1 {
		t.Fatalf("expected skipped_owned=1, got %d", response["skipped_owned"])
	}
	if response["skipped_duplicate"] != 1 {
		t.Fatalf("expected skipped_duplicate=1, got %d", response["skipped_duplicate"])
	}
}

func TestHandleListHistory_ReturnsAccurateTotal(t *testing.T) {
	s := newTestServer(t)
	for i := 0; i < 3; i++ {
		if err := s.db.InsertHistory(&models.HistoryEntry{
			GalleryID: "gallery",
			Status:    "success",
			Timestamp: time.Now(),
		}); err != nil {
			t.Fatalf("failed to insert history: %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/history?page=2&limit=2", nil)
	rec := httptest.NewRecorder()

	s.handleListHistory(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response struct {
		Total   int                   `json:"total"`
		Page    int                   `json:"page"`
		Results []models.HistoryEntry `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode history response: %v", err)
	}

	if response.Total != 3 {
		t.Fatalf("expected total=3, got %d", response.Total)
	}
	if response.Page != 2 {
		t.Fatalf("expected page=2, got %d", response.Page)
	}
	if len(response.Results) != 1 {
		t.Fatalf("expected one history result on second page, got %d", len(response.Results))
	}
}
