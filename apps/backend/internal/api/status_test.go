package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"doujinshi-manager/internal/config"
	"doujinshi-manager/internal/downloader"
)

func TestHandleStatus_IncludesAppVersion(t *testing.T) {
	s := newTestServer(t)
	s.config = &config.Config{ServerPort: config.DefaultServerPort}
	s.downloader = downloader.NewManager(s.db, nil, nil, s.config)

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()

	s.handleStatus(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d with body %s", rec.Code, rec.Body.String())
	}

	var response struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode status response: %v", err)
	}

	if response.Version == "" {
		t.Fatal("expected status response to include a version")
	}
}
