package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultPageWorkers     = 10
	MinPageWorkers         = 1
	MaxPageWorkers         = 20
	DefaultGalleryWorkers  = 2
	MinGalleryWorkers      = 1
	MaxGalleryWorkers      = 5
	DefaultAPIRequestDelay = 0.25
	MinDelaySeconds        = 0.0
	MaxDelaySeconds        = 60.0
	DefaultServerPort      = 8080
	MinServerPort          = 1024
	MaxServerPort          = 65535
)

// Config contains the persisted runtime settings for the local app.
type Config struct {
	LibraryPath     string  `json:"library_path"`
	DownloadPath    string  `json:"download_path"`
	PageWorkers     int     `json:"page_workers"`
	GalleryWorkers  int     `json:"gallery_workers"`
	APIRequestDelay float64 `json:"api_request_delay"`
	ServerPort      int     `json:"server_port"`
}

// DefaultConfig returns the default application configuration.
func DefaultConfig() *Config {
	cfg := &Config{
		LibraryPath:     defaultLibraryPath(),
		DownloadPath:    "",
		PageWorkers:     DefaultPageWorkers,
		GalleryWorkers:  DefaultGalleryWorkers,
		APIRequestDelay: DefaultAPIRequestDelay,
		ServerPort:      DefaultServerPort,
	}
	cfg.EnsureDefaults()
	return cfg
}

func defaultLibraryPath() string {
	homeDir, err := os.UserHomeDir()
	if err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, "Doujinshi Library")
	}
	return "library"
}

// EnsureDefaults fills missing configuration values with safe defaults.
func (c *Config) EnsureDefaults() {
	if strings.TrimSpace(c.LibraryPath) == "" {
		c.LibraryPath = defaultLibraryPath()
	}
	c.LibraryPath = filepath.Clean(strings.TrimSpace(c.LibraryPath))

	c.DownloadPath = strings.TrimSpace(c.DownloadPath)
	if c.DownloadPath != "" {
		c.DownloadPath = filepath.Clean(c.DownloadPath)
	}

	if c.PageWorkers <= 0 {
		c.PageWorkers = DefaultPageWorkers
	}
	if c.GalleryWorkers <= 0 {
		c.GalleryWorkers = DefaultGalleryWorkers
	}
	if c.APIRequestDelay < MinDelaySeconds {
		c.APIRequestDelay = DefaultAPIRequestDelay
	}
	if c.ServerPort <= 0 {
		c.ServerPort = DefaultServerPort
	}
}

// Validate ensures that all config values are within supported ranges.
func (c *Config) Validate() error {
	c.EnsureDefaults()

	if strings.TrimSpace(c.LibraryPath) == "" {
		return fmt.Errorf("library path is required")
	}
	if c.PageWorkers < MinPageWorkers || c.PageWorkers > MaxPageWorkers {
		return fmt.Errorf("page workers must be between %d and %d", MinPageWorkers, MaxPageWorkers)
	}
	if c.GalleryWorkers < MinGalleryWorkers || c.GalleryWorkers > MaxGalleryWorkers {
		return fmt.Errorf("gallery workers must be between %d and %d", MinGalleryWorkers, MaxGalleryWorkers)
	}
	if c.APIRequestDelay < MinDelaySeconds || c.APIRequestDelay > MaxDelaySeconds {
		return fmt.Errorf("api request delay must be between 0 and 60 seconds")
	}
	if c.ServerPort < MinServerPort || c.ServerPort > MaxServerPort {
		return fmt.Errorf("server port must be between %d and %d", MinServerPort, MaxServerPort)
	}

	libraryInfo, err := os.Stat(c.LibraryPath)
	if err != nil {
		return fmt.Errorf("library path must exist and be a directory")
	}
	if !libraryInfo.IsDir() {
		return fmt.Errorf("library path must be a directory")
	}

	if c.DownloadPath != "" {
		downloadInfo, err := os.Stat(c.DownloadPath)
		if err != nil {
			return fmt.Errorf("download path must exist and be a directory")
		}
		if !downloadInfo.IsDir() {
			return fmt.Errorf("download path must be a directory")
		}
	}

	return nil
}

// EffectiveDownloadPath returns the temporary staging path for active downloads.
func (c *Config) EffectiveDownloadPath() string {
	if strings.TrimSpace(c.DownloadPath) != "" {
		return filepath.Clean(c.DownloadPath)
	}
	return filepath.Join(os.TempDir(), "doujinshi-manager")
}

// LoadConfig loads configuration from disk or returns defaults when missing.
func LoadConfig(path string) (*Config, error) {
	config := DefaultConfig()

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return config, nil
		}
		return nil, fmt.Errorf("failed to open config file: %w", err)
	}
	defer file.Close()

	if err := json.NewDecoder(file).Decode(config); err != nil {
		return nil, fmt.Errorf("failed to decode config: %w", err)
	}

	config.EnsureDefaults()
	return config, nil
}

// Save persists the configuration atomically after validating it.
func (c *Config) Save(path string) error {
	c.EnsureDefaults()

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	if err := os.MkdirAll(c.LibraryPath, 0755); err != nil {
		return fmt.Errorf("failed to create library directory: %w", err)
	}
	if c.DownloadPath != "" {
		if err := os.MkdirAll(c.DownloadPath, 0755); err != nil {
			return fmt.Errorf("failed to create download directory: %w", err)
		}
	}
	if err := c.Validate(); err != nil {
		return err
	}

	tempFile, err := os.CreateTemp(filepath.Dir(path), "config-*.json")
	if err != nil {
		return fmt.Errorf("failed to create temp config file: %w", err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	encoder := json.NewEncoder(tempFile)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(c); err != nil {
		tempFile.Close()
		return fmt.Errorf("failed to encode config: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("failed to close temp config file: %w", err)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to replace existing config file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("failed to save config file: %w", err)
	}

	return nil
}
