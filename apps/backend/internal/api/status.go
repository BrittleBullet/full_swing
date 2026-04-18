package api

import (
	"net/http"

	"doujinshi-manager/internal/models"
)

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

	// Current job from live downloader progress when available.
	var currentJob interface{}
	if downloadingCount > 0 {
		if progress := s.downloader.CurrentProgress(); progress != nil {
			currentJob = map[string]interface{}{
				"id":           progress.GalleryID,
				"title":        progress.Title,
				"current_page": progress.CurrentPage,
				"total_pages":  progress.TotalPages,
				"percentage":   progress.Percentage,
				"status":       progress.Status,
			}
		} else {
			entries, err := s.db.ListQueue(models.StatusDownloading)
			if err == nil && len(entries) > 0 {
				currentJob = map[string]interface{}{
					"id":           entries[0].ID,
					"title":        entries[0].Title,
					"current_page": 0,
					"total_pages":  0,
					"percentage":   0,
					"status":       "downloading",
				}
			}
		}
	}

	lastBatchSuccess, lastBatchFailed := s.downloader.LastBatchResults()

	response := map[string]interface{}{
		"running":            true,
		"queue_count":        queueCount,
		"owned_count":        ownedCount,
		"failed_count":       failedCount,
		"downloading":        downloadingCount > 0,
		"current_job":        currentJob,
		"last_batch_success": lastBatchSuccess,
		"last_batch_failed":  lastBatchFailed,
	}

	writeJSON(w, http.StatusOK, response)
}
