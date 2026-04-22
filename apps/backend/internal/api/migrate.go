package api

import (
	"context"
	"net/http"
	"time"
)

const librarySyncTimeout = 5 * time.Minute

func (s *Server) handleMigrate(w http.ResponseWriter, r *http.Request) {
	ownedCount, err := s.db.CountOwned()
	if err != nil {
		writeInternalError(w, r, "failed to count owned entries", err)
		return
	}
	if ownedCount > 0 {
		writeError(w, http.StatusConflict, "migration already completed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), librarySyncTimeout)
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
