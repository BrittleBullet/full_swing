package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

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

func TestCorsMiddleware_AllowsElectronFileOrigin(t *testing.T) {
	router := chi.NewRouter()
	SetupMiddleware(router)
	router.Get("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("Origin", "null")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Result().Header.Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("expected null origin to be allowed for Electron UI, got %q", rec.Result().Header.Get("Access-Control-Allow-Origin"))
	}
}

func TestCorsMiddleware_AllowsElectronFileSchemeOrigin(t *testing.T) {
	router := chi.NewRouter()
	SetupMiddleware(router)
	router.Get("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("Origin", "file://")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Result().Header.Get("Access-Control-Allow-Origin") != "file://" {
		t.Fatalf("expected file origin to be allowed for Electron UI, got %q", rec.Result().Header.Get("Access-Control-Allow-Origin"))
	}
}
