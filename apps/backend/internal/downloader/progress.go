package downloader

import "doujinshi-manager/internal/models"

// ProgressTracker accumulates per-gallery progress updates for SSE clients.
type ProgressTracker struct {
	galleryID string
	title     string
	total     int
	current   int
	status    string
}

// NewProgressTracker creates a tracker for a single gallery download.
func NewProgressTracker(galleryID, title string, totalPages int) *ProgressTracker {
	return &ProgressTracker{
		galleryID: galleryID,
		title:     title,
		total:     totalPages,
		status:    "downloading",
	}
}

// Update records the latest completed page count.
func (p *ProgressTracker) Update(current int) {
	p.current = current
}

// Complete marks the gallery as fully downloaded.
func (p *ProgressTracker) Complete() {
	p.current = p.total
	p.status = "done"
}

// Fail marks the gallery as failed.
func (p *ProgressTracker) Fail() {
	p.status = "failed"
}

// ToProgress converts the tracker state into an SSE payload.
func (p *ProgressTracker) ToProgress() models.DownloadProgress {
	percentage := 0.0
	if p.total > 0 {
		percentage = float64(p.current) / float64(p.total) * 100
	}

	return models.DownloadProgress{
		GalleryID:   p.galleryID,
		Title:       p.title,
		CurrentPage: p.current,
		TotalPages:  p.total,
		Percentage:  percentage,
		Status:      p.status,
	}
}
