package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	errorInvalidID       = "invalid id"
	errorInternalMessage = "internal server error"
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

// decodeJSONBody decodes JSON with unknown fields rejected.
func decodeJSONBody(r *http.Request, dst interface{}) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(dst)
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
	if len(ids) == 0 {
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
