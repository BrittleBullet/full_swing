package api

import (
	"net/http"
	"strings"

	"doujinshi-manager/internal/config"
)

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.config)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var updates struct {
		LibraryPath     *string  `json:"library_path"`
		DownloadPath    *string  `json:"download_path"`
		PageWorkers     *int     `json:"page_workers"`
		GalleryWorkers  *int     `json:"gallery_workers"`
		APIRequestDelay *float64 `json:"api_request_delay"`
		DownloadDelay   *float64 `json:"download_delay"`
		ServerPort      *int     `json:"server_port"`
	}
	if err := decodeJSONBody(r, &updates); err != nil {
		writeError(w, http.StatusBadRequest, "invalid settings payload")
		return
	}

	nextConfig := *s.config
	if updates.LibraryPath != nil {
		nextConfig.LibraryPath = strings.TrimSpace(*updates.LibraryPath)
	}
	if updates.DownloadPath != nil {
		nextConfig.DownloadPath = strings.TrimSpace(*updates.DownloadPath)
	}
	if updates.PageWorkers != nil {
		nextConfig.PageWorkers = *updates.PageWorkers
	}
	if updates.GalleryWorkers != nil {
		nextConfig.GalleryWorkers = *updates.GalleryWorkers
	}
	if updates.APIRequestDelay != nil {
		nextConfig.APIRequestDelay = *updates.APIRequestDelay
	}
	if updates.DownloadDelay != nil {
		nextConfig.DownloadDelay = *updates.DownloadDelay
	}
	if updates.ServerPort != nil {
		nextConfig.ServerPort = *updates.ServerPort
	}

	nextConfig.EnsureDefaults()
	if err := nextConfig.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := nextConfig.Save(s.configPath); err != nil {
		writeInternalError(w, r, "failed to save settings", err)
		return
	}

	s.config = &nextConfig
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":                true,
		"library_path":      s.config.LibraryPath,
		"download_path":     s.config.DownloadPath,
		"page_workers":      s.config.PageWorkers,
		"gallery_workers":   s.config.GalleryWorkers,
		"api_request_delay": s.config.APIRequestDelay,
		"download_delay":    s.config.DownloadDelay,
		"server_port":       s.config.ServerPort,
		"limits": map[string]interface{}{
			"page_workers":    []int{config.MinPageWorkers, config.MaxPageWorkers},
			"gallery_workers": []int{config.MinGalleryWorkers, config.MaxGalleryWorkers},
			"delay_seconds":   []float64{config.MinDelaySeconds, config.MaxDelaySeconds},
			"server_port":     []int{config.MinServerPort, config.MaxServerPort},
		},
	})
}
