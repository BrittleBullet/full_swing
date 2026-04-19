package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfigUsesSimplifiedDefaults(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.PageWorkers != DefaultPageWorkers {
		t.Fatalf("expected page workers %d, got %d", DefaultPageWorkers, cfg.PageWorkers)
	}
	if cfg.GalleryWorkers != DefaultGalleryWorkers {
		t.Fatalf("expected gallery workers %d, got %d", DefaultGalleryWorkers, cfg.GalleryWorkers)
	}
	if cfg.APIRequestDelay != DefaultAPIRequestDelay {
		t.Fatalf("expected api request delay %v, got %v", DefaultAPIRequestDelay, cfg.APIRequestDelay)
	}
}

func TestLoadConfigIgnoresLegacyDelayFields(t *testing.T) {
	dir := t.TempDir()
	libraryDir := filepath.Join(dir, "library")
	if err := os.MkdirAll(libraryDir, 0755); err != nil {
		t.Fatalf("failed to create library dir: %v", err)
	}

	configPath := filepath.Join(dir, "config.json")
	json := `{
  "library_path": "` + filepath.ToSlash(libraryDir) + `",
  "page_workers": 7,
  "gallery_workers": 1,
  "api_request_delay": 1.5,
  "image_request_delay": 0.2,
  "download_delay": 0.5,
  "server_port": 9000
}`
	if err := os.WriteFile(configPath, []byte(json), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	cfg, err := LoadConfig(configPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if cfg.PageWorkers != 7 || cfg.GalleryWorkers != 1 || cfg.APIRequestDelay != 1.5 || cfg.ServerPort != 9000 {
		t.Fatalf("unexpected config loaded: %+v", cfg)
	}
}
