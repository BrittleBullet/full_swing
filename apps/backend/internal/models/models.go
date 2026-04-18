package models

import "time"

type GalleryStatus string

const (
	StatusPending     GalleryStatus = "pending"
	StatusDownloading GalleryStatus = "downloading"
	StatusDone        GalleryStatus = "done"
	StatusFailed      GalleryStatus = "failed"
	StatusDuplicate   GalleryStatus = "duplicate"
)

type OwnedEntry struct {
	ID      string    `json:"id"`
	MediaID string    `json:"media_id"`
	Title   string    `json:"title"`
	Artist  string    `json:"artist"`
	AddedAt time.Time `json:"added_at"`
}

type QueueEntry struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	Artist    string        `json:"artist"`
	Status    GalleryStatus `json:"status"`
	Error     string        `json:"error,omitempty"`
	AddedAt   time.Time     `json:"added_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

type HistoryEntry struct {
	ID        int       `json:"id"`
	GalleryID string    `json:"gallery_id"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

type DownloadProgress struct {
	GalleryID   string  `json:"gallery_id"`
	Title       string  `json:"title"`
	CurrentPage int     `json:"current_page"`
	TotalPages  int     `json:"total_pages"`
	Percentage  float64 `json:"percentage"`
	Status      string  `json:"status"`
}
