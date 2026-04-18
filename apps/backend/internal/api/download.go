package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"doujinshi-manager/internal/models"
)

func (s *Server) handleDownloadStart(w http.ResponseWriter, r *http.Request) {
	entries, err := s.db.ListQueue(models.StatusPending)
	if err != nil {
		writeInternalError(w, r, "failed to list pending queue entries", err)
		return
	}

	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.ID)
	}

	if err := s.downloader.Enqueue(ids); err != nil {
		writeInternalError(w, r, "failed to enqueue pending downloads", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDownloadStop(w http.ResponseWriter, r *http.Request) {
	cancelled := s.downloader.CancelDownloads()
	log.Printf("[INFO] cancellation requested; removed %d queued galleries from the active batch", cancelled)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "cancelled": cancelled})
}

func (s *Server) handleDownloadRetry(w http.ResponseWriter, r *http.Request) {
	id, err := normalizeNumericID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	if err := s.db.UpdateQueueStatus(id, models.StatusPending, ""); err != nil {
		writeInternalError(w, r, "failed to reset queue status", err)
		return
	}
	if err := s.downloader.Enqueue([]string{id}); err != nil {
		writeInternalError(w, r, "failed to retry download", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDownloadProgress(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	progressCh := s.downloader.Progress()
	if _, err := fmt.Fprintf(w, "data: %s\n\n", "{}"); err != nil {
		log.Printf("[WARN] failed to write initial progress payload: %v", err)
		return
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case progress, ok := <-progressCh:
			if !ok {
				return
			}
			data, err := json.Marshal(progress)
			if err != nil {
				log.Printf("[WARN] failed to marshal download progress: %v", err)
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				log.Printf("[WARN] failed to stream download progress: %v", err)
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}
