package api

import (
	"net/http"

	"doujinshi-manager/internal/models"
)

// AppVersion must be updated together with the browser extension release version.
const AppVersion = "1.0.0"

// StatusJob describes the active gallery download in the status response.
type StatusJob struct {
	ID               string  `json:"id"`
	Title            string  `json:"title"`
	CurrentPage      int     `json:"current_page"`
	TotalPages       int     `json:"total_pages"`
	Percentage       float64 `json:"percentage"`
	Status           string  `json:"status"`
	GalleryElapsedMs int64   `json:"gallery_elapsed_ms"`
	BatchElapsedMs   int64   `json:"batch_elapsed_ms"`
}

// StatusResponse is the payload returned by the local status endpoint.
type StatusResponse struct {
	Running          bool       `json:"running"`
	Version          string     `json:"version"`
	ServerPort       int        `json:"server_port"`
	Downloading      bool       `json:"downloading"`
	Paused           bool       `json:"paused"`
	QueueCount       int        `json:"queue_count"`
	OwnedCount       int        `json:"owned_count"`
	FailedCount      int        `json:"failed_count"`
	CurrentJob       *StatusJob `json:"current_job"`
	LastBatchSuccess int        `json:"last_batch_success"`
	LastBatchFailed  int        `json:"last_batch_failed"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	// Get counts
	ownedCount, err := s.db.CountOwned()
	if err != nil {
		writeInternalError(w, r, "failed to count owned entries", err)
		return
	}

	queueCount, err := s.db.CountQueueByStatus(models.StatusPending)
	if err != nil {
		writeInternalError(w, r, "failed to count pending queue entries", err)
		return
	}

	failedCount, err := s.db.CountQueueByStatus(models.StatusFailed)
	if err != nil {
		writeInternalError(w, r, "failed to count failed queue entries", err)
		return
	}

	// Check if downloading
	downloadingCount, err := s.db.CountQueueByStatus(models.StatusDownloading)
	if err != nil {
		writeInternalError(w, r, "failed to count active downloads", err)
		return
	}

	// Current or most recent job from live downloader progress when available.
	var currentJob *StatusJob
	if progress := s.downloader.CurrentProgress(); progress != nil {
		currentJob = &StatusJob{
			ID:               progress.GalleryID,
			Title:            progress.Title,
			CurrentPage:      progress.CurrentPage,
			TotalPages:       progress.TotalPages,
			Percentage:       progress.Percentage,
			Status:           progress.Status,
			GalleryElapsedMs: progress.GalleryElapsedMs,
			BatchElapsedMs:   progress.BatchElapsedMs,
		}
	} else if downloadingCount > 0 {
		entries, err := s.db.ListQueue(models.StatusDownloading)
		if err == nil && len(entries) > 0 {
			currentJob = &StatusJob{
				ID:               entries[0].ID,
				Title:            entries[0].Title,
				CurrentPage:      0,
				TotalPages:       0,
				Percentage:       0,
				Status:           "downloading",
				GalleryElapsedMs: 0,
				BatchElapsedMs:   0,
			}
		}
	}

	lastBatchSuccess, lastBatchFailed := s.downloader.LastBatchResults()

	response := StatusResponse{
		Running:          true,
		Version:          AppVersion,
		ServerPort:       s.config.ServerPort,
		Downloading:      downloadingCount > 0,
		Paused:           s.downloader.IsPaused(),
		QueueCount:       queueCount + downloadingCount,
		OwnedCount:       ownedCount,
		FailedCount:      failedCount,
		CurrentJob:       currentJob,
		LastBatchSuccess: lastBatchSuccess,
		LastBatchFailed:  lastBatchFailed,
	}

	writeJSON(w, http.StatusOK, response)
}
