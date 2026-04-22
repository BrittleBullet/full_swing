package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

const libraryReconcileTimeout = 2 * time.Minute

func (s *Server) handleOwnedCheck(w http.ResponseWriter, r *http.Request) {
	id, err := normalizeNumericID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	owned, dbErr := s.db.GetOwnedByID(id)
	if dbErr != nil {
		writeInternalError(w, r, "failed to check owned state", dbErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"owned": owned != nil})
}

func (s *Server) handleOwnedCheckBatch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	validatedIDs, err := validateNumericIDList(req.IDs)
	if err != nil {
		writeError(w, http.StatusBadRequest, errorInvalidID)
		return
	}

	result := make(map[string]bool, len(validatedIDs))
	for _, id := range validatedIDs {
		owned, dbErr := s.db.GetOwnedByID(id)
		if dbErr != nil {
			writeInternalError(w, r, "failed to check owned gallery batch", dbErr)
			return
		}
		result[id] = owned != nil
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleOwnedIDs(w http.ResponseWriter, r *http.Request) {
	ids, err := s.db.ListOwnedIDs()
	if err != nil {
		writeInternalError(w, r, "failed to list owned ids", err)
		return
	}

	writeJSON(w, http.StatusOK, ids)
}

func (s *Server) handleClearOwned(w http.ResponseWriter, r *http.Request) {
	cleared, err := s.db.ClearOwned()
	if err != nil {
		writeInternalError(w, r, "failed to clear owned entries", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]int{"cleared": cleared})
}

func (s *Server) handleLibraryReconcile(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), libraryReconcileTimeout)
	defer cancel()

	removed, err := s.library.Reconcile(ctx)
	if err != nil {
		writeInternalError(w, r, "failed to reconcile library", err)
		return
	}

	remaining, err := s.db.CountOwned()
	if err != nil {
		writeInternalError(w, r, "failed to count library entries", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]int{
		"removed": removed,
		"owned":   remaining,
	})
}

func (s *Server) handleListLibrary(w http.ResponseWriter, r *http.Request) {
	page := 1
	if pageStr := r.URL.Query().Get("page"); pageStr != "" {
		value, err := strconv.Atoi(pageStr)
		if err != nil || value <= 0 {
			writeError(w, http.StatusBadRequest, "invalid page")
			return
		}
		page = value
	}

	limit := 50
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		value, err := strconv.Atoi(limitStr)
		if err != nil || value <= 0 || value > 100 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = value
	}

	offset := (page - 1) * limit
	entries, err := s.db.ListOwned(limit, offset)
	if err != nil {
		writeInternalError(w, r, "failed to list library entries", err)
		return
	}

	total, err := s.db.CountOwned()
	if err != nil {
		writeInternalError(w, r, "failed to count library entries", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"total":   total,
		"page":    page,
		"results": entries,
	})
}
