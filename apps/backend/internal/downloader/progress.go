package downloader

import "doujinshi-manager/internal/models"

type ProgressTracker struct {
	galleryID string
	title     string
	total     int
	current   int
	status    string
}

func NewProgressTracker(galleryID, title string, totalPages int) *ProgressTracker {
	return &ProgressTracker{
		galleryID: galleryID,
		title:     title,
		total:     totalPages,
		status:    "downloading",
	}
}

func (p *ProgressTracker) Update(current int) {
	p.current = current
}

func (p *ProgressTracker) Complete() {
	p.current = p.total
	p.status = "done"
}

func (p *ProgressTracker) Fail() {
	p.status = "failed"
}

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
