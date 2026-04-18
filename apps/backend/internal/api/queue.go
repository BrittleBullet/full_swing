package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"doujinshi-manager/internal/models"
	"doujinshi-manager/internal/nhentai"
)

func (s *Server) handleListQueue(w http.ResponseWriter, r *http.Request) {
	statusParam := r.URL.Query().Get("status")
	var statusFilter models.GalleryStatus
	if statusParam != "" {
		statusFilter = models.GalleryStatus(statusParam)
	}

	entries, err := s.db.ListQueue(statusFilter)
	if err != nil {
		writeInternalError(w, r, "failed to list queue", err)
		return
	}

	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleEnqueue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		log.Printf("[WARN] %s %s: invalid enqueue payload: %v", r.Method, r.URL.Path, err)
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	validatedIDs, err := validateNumericIDList(req.IDs)
	if err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	added := 0
	skippedOwned := 0
	skippedDuplicate := 0
	pendingEntries := make([]*models.QueueEntry, 0, len(validatedIDs))

	for _, id := range validatedIDs {
		entry, err := s.db.GetQueueByID(id)
		if err != nil {
			writeInternalError(w, r, "failed to check existing queue entry", err)
			return
		}
		if entry != nil {
			skippedDuplicate++
			continue
		}

		fetchCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		gallery, err := s.nhentai.FetchGallery(fetchCtx, id)
		cancel()
		if err != nil {
			if errors.Is(err, nhentai.ErrGalleryNotFound) {
				skippedOwned++
				continue
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				log.Printf("[WARN] timed out while fetching gallery metadata for %s", id)
				continue
			}
			writeInternalError(w, r, "failed to fetch gallery metadata", err)
			return
		}

		owned, err := s.db.GetOwnedByMediaID(gallery.MediaID)
		if err != nil {
			writeInternalError(w, r, "failed to check owned state", err)
			return
		}
		if owned != nil {
			skippedOwned++
			continue
		}

		now := time.Now()
		pendingEntries = append(pendingEntries, &models.QueueEntry{
			ID:        id,
			Title:     gallery.Title.Pretty,
			Artist:    extractArtist(gallery),
			Status:    models.StatusPending,
			AddedAt:   now,
			UpdatedAt: now,
		})
	}

	if err := s.db.InsertQueueBatch(pendingEntries); err != nil {
		writeInternalError(w, r, "failed to insert queued galleries", err)
		return
	}
	added = len(pendingEntries)

	writeJSON(w, http.StatusOK, map[string]int{
		"added":             added,
		"skipped_owned":     skippedOwned,
		"skipped_duplicate": skippedDuplicate,
	})
}

func (s *Server) handleDeleteQueue(w http.ResponseWriter, r *http.Request) {
	id, err := normalizeNumericID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	if err := s.db.DeleteQueue(id); err != nil {
		writeInternalError(w, r, "failed to delete queued gallery", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleClearQueue(w http.ResponseWriter, r *http.Request) {
	count, err := s.db.CountQueue()
	if err != nil {
		writeInternalError(w, r, "failed to count queued galleries", err)
		return
	}
	if err := s.db.ClearQueue(); err != nil {
		writeInternalError(w, r, "failed to clear queue", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"cleared": count})
}

func extractArtist(gallery *nhentai.Gallery) string {
	for _, tag := range gallery.Tags {
		if tag.Type == "artist" {
			return tag.Name
		}
	}
	for _, tag := range gallery.Tags {
		if tag.Type == "group" {
			return tag.Name
		}
	}
	return ""
}
