package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"doujinshi-manager/internal/library"
	"doujinshi-manager/internal/models"
)

func TestHandleMigrate_RejectsWhenOwnedAlreadyPopulated(t *testing.T) {
	s := newTestServer(t)
	s.library = library.NewScanner(t.TempDir(), s.db)

	if err := s.db.InsertOwned(&models.OwnedEntry{
		ID:      "123456",
		MediaID: "media-123456",
		Title:   "Owned",
		Artist:  "Artist",
		AddedAt: time.Now(),
	}); err != nil {
		t.Fatalf("failed to insert owned entry: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/migrate", nil)
	rec := httptest.NewRecorder()

	s.handleMigrate(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status 409, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if response["error"] != "migration already completed" {
		t.Fatalf("unexpected conflict message: %q", response["error"])
	}
}

func TestHandleClearOwned_RemovesAllEntries(t *testing.T) {
	s := newTestServer(t)

	for _, entry := range []*models.OwnedEntry{
		{
			ID:      "123456",
			MediaID: "media-123456",
			Title:   "Owned One",
			Artist:  "Artist One",
			AddedAt: time.Now(),
		},
		{
			ID:      "654321",
			MediaID: "media-654321",
			Title:   "Owned Two",
			Artist:  "Artist Two",
			AddedAt: time.Now(),
		},
	} {
		if err := s.db.InsertOwned(entry); err != nil {
			t.Fatalf("failed to insert owned entry: %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/owned", nil)
	rec := httptest.NewRecorder()

	s.handleClearOwned(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if response["cleared"] != 2 {
		t.Fatalf("expected cleared=2, got %d", response["cleared"])
	}

	remaining, err := s.db.CountOwned()
	if err != nil {
		t.Fatalf("failed to count owned entries: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected owned table to be empty, got %d", remaining)
	}
}

func TestHandleLibraryReconcile_RemovesMissingOwnedEntries(t *testing.T) {
	s := newTestServer(t)
	s.library = library.NewScanner(t.TempDir(), s.db)

	if err := s.db.InsertOwned(&models.OwnedEntry{
		ID:      "123456",
		MediaID: "media-123456",
		Title:   "Missing Title",
		Artist:  "Missing Artist",
		AddedAt: time.Now(),
	}); err != nil {
		t.Fatalf("failed to insert owned entry: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/library/reconcile", nil)
	rec := httptest.NewRecorder()

	s.handleLibraryReconcile(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if response["removed"] != 1 {
		t.Fatalf("expected removed=1, got %d", response["removed"])
	}
	if response["owned"] != 0 {
		t.Fatalf("expected owned=0, got %d", response["owned"])
	}
}
