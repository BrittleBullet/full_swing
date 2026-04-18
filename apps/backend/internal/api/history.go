package api

import (
	"net/http"
	"strconv"
)

func (s *Server) handleListHistory(w http.ResponseWriter, r *http.Request) {
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
	entries, err := s.db.ListHistory(limit, offset)
	if err != nil {
		writeInternalError(w, r, "failed to list history", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"total":   len(entries) * page,
		"page":    page,
		"results": entries,
	})
}
