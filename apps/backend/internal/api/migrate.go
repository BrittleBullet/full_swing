package api

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) handleMigrate(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	found, inserted, err := s.library.Scan(ctx)
	if err != nil {
		writeInternalError(w, r, "failed to migrate library", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]int{
		"found":    found,
		"inserted": inserted,
	})
}
