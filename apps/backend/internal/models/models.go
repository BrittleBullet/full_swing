package models

import "time"

// GalleryStatus represents the queue lifecycle state for a gallery.
type GalleryStatus string

const (
	StatusPending     GalleryStatus = "pending"
	StatusDownloading GalleryStatus = "downloading"
	StatusDone        GalleryStatus = "done"
	StatusFailed      GalleryStatus = "failed"
	StatusDuplicate   GalleryStatus = "duplicate"
	StatusNotFound    GalleryStatus = "not_found"
)

// OwnedEntry records a gallery that is already present in the local library.
type OwnedEntry struct {
	ID      string    `json:"id"`
	MediaID string    `json:"media_id"`
	Title   string    `json:"title"`
	Artist  string    `json:"artist"`
	AddedAt time.Time `json:"added_at"`
}

// QueueEntry represents a gallery queued for download processing.
type QueueEntry struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	Artist    string        `json:"artist"`
	Status    GalleryStatus `json:"status"`
	Error     string        `json:"error,omitempty"`
	AddedAt   time.Time     `json:"added_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// HistoryEntry captures a past queue event for the activity log.
type HistoryEntry struct {
	ID        int       `json:"id"`
	GalleryID string    `json:"gallery_id"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// DownloadProgress describes the current SSE payload for an active gallery.
type DownloadProgress struct {
	GalleryID        string  `json:"gallery_id"`
	Title            string  `json:"title"`
	CurrentPage      int     `json:"current_page"`
	TotalPages       int     `json:"total_pages"`
	Percentage       float64 `json:"percentage"`
	Status           string  `json:"status"`
	GalleryElapsedMs int64   `json:"gallery_elapsed_ms,omitempty"`
	BatchElapsedMs   int64   `json:"batch_elapsed_ms,omitempty"`
}
