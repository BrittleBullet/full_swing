package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"doujinshi-manager/internal/models"
)

const (
	errorInvalidID       = "invalid id"
	errorInternalMessage = "internal server error"
	maxJSONBodyBytes     = 1 << 20
	maxIDListLength      = 5000
)

var numericIDPattern = regexp.MustCompile(`^\d+$`)

// writeJSON writes a JSON response with the provided status code.
func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("[ERROR] failed to encode JSON response: %v", err)
	}
}

// writeError writes a JSON error response.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// writeInternalError logs the detailed error server-side and returns a generic error to clients.
func writeInternalError(w http.ResponseWriter, r *http.Request, message string, err error) {
	if err != nil {
		log.Printf("[ERROR] %s %s: %s: %v", r.Method, r.URL.Path, message, err)
	} else {
		log.Printf("[ERROR] %s %s: %s", r.Method, r.URL.Path, message)
	}
	writeError(w, http.StatusInternalServerError, errorInternalMessage)
}

// decodeJSONBody decodes a bounded JSON request body with unknown fields rejected.
func decodeJSONBody(r *http.Request, dst interface{}) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}

	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain a single JSON object")
		}
		return errors.New("request body must contain a single JSON object")
	}

	return nil
}

// normalizeNumericID validates that an ID is a non-empty numeric string.
func normalizeNumericID(id string) (string, error) {
	normalized := strings.TrimSpace(id)
	if normalized == "" || !numericIDPattern.MatchString(normalized) {
		return "", errors.New(errorInvalidID)
	}
	return normalized, nil
}

// validateNumericIDList validates a non-empty list of numeric IDs and deduplicates it.
func validateNumericIDList(ids []string) ([]string, error) {
	if len(ids) == 0 || len(ids) > maxIDListLength {
		return nil, errors.New(errorInvalidID)
	}

	seen := make(map[string]struct{}, len(ids))
	validated := make([]string, 0, len(ids))
	for _, rawID := range ids {
		id, err := normalizeNumericID(rawID)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		validated = append(validated, id)
	}

	if len(validated) == 0 {
		return nil, errors.New(errorInvalidID)
	}

	return validated, nil
}

// validateGalleryStatus ensures a queue status filter is one of the supported values.
func validateGalleryStatus(value string) (models.GalleryStatus, error) {
	status := models.GalleryStatus(strings.TrimSpace(strings.ToLower(value)))
	switch status {
	case "", models.StatusPending, models.StatusDownloading, models.StatusDone, models.StatusFailed, models.StatusDuplicate, models.StatusNotFound:
		return status, nil
	default:
		return "", errors.New("invalid status")
	}
}

// pathWithinBase reports whether target resolves within base.
func pathWithinBase(basePath, targetPath string) bool {
	baseAbs, err := filepath.Abs(basePath)
	if err != nil {
		return false
	}
	targetAbs, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(baseAbs, targetAbs)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}
