package downloader

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"doujinshi-manager/internal/config"
	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/library"
	"doujinshi-manager/internal/models"
	"doujinshi-manager/internal/nhentai"
)

type Manager struct {
	db      *database.DB
	nhentai *nhentai.Client
	library *library.Builder
	config  *config.Config

	jobCh    chan string                  // gallery IDs to process
	progress chan models.DownloadProgress // progress events for SSE
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	stateMu          sync.RWMutex
	currentProgress  *models.DownloadProgress
	lastBatchSuccess int
	lastBatchFailed  int
	batchInProgress  bool
	shuttingDown     bool
	currentCancels   map[string]context.CancelFunc
}

func NewManager(db *database.DB, nhentai *nhentai.Client, library *library.Builder, config *config.Config) *Manager {
	return &Manager{
		db:             db,
		nhentai:        nhentai,
		library:        library,
		config:         config,
		jobCh:          make(chan string, 100),
		progress:       make(chan models.DownloadProgress, 100),
		currentCancels: make(map[string]context.CancelFunc),
	}
}

func (m *Manager) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	m.stateMu.Lock()
	m.shuttingDown = false
	m.stateMu.Unlock()

	log.Printf("[DOWNLOADER] Starting downloader manager with %d gallery workers", m.config.GalleryWorkers)
	// Start gallery workers
	for i := 0; i < m.config.GalleryWorkers; i++ {
		m.wg.Add(1)
		go m.galleryWorker(ctx)
	}
	log.Printf("[DOWNLOADER] Downloader manager started")
}

func (m *Manager) Stop() {
	m.stateMu.Lock()
	m.shuttingDown = true
	m.stateMu.Unlock()
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
	close(m.jobCh)
	close(m.progress)
}

func (m *Manager) Enqueue(ids []string) error {
	log.Printf("[ENQUEUE] Attempting to enqueue %d galleries", len(ids))
	if len(ids) > 0 {
		m.beginBatch()
	}
	for _, id := range ids {
		select {
		case m.jobCh <- id:
			log.Printf("[ENQUEUE] Enqueued gallery: %s", id)
		default:
			log.Printf("[ENQUEUE] ERROR: queue full")
			return fmt.Errorf("queue full")
		}
	}
	log.Printf("[ENQUEUE] All %d galleries enqueued successfully", len(ids))
	return nil
}

func (m *Manager) Progress() <-chan models.DownloadProgress {
	return m.progress
}

func (m *Manager) CurrentProgress() *models.DownloadProgress {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()

	if m.currentProgress == nil {
		return nil
	}

	copy := *m.currentProgress
	return &copy
}

func (m *Manager) LastBatchResults() (int, int) {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.lastBatchSuccess, m.lastBatchFailed
}

func (m *Manager) beginBatch() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	if !m.batchInProgress {
		m.lastBatchSuccess = 0
		m.lastBatchFailed = 0
	}
	m.batchInProgress = true
}

func (m *Manager) setCurrentProgress(progress models.DownloadProgress) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	copy := progress
	m.currentProgress = &copy
}

func (m *Manager) clearCurrentProgress() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	m.currentProgress = nil
}

func (m *Manager) setActiveGallery(galleryID string, cancel context.CancelFunc) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if m.currentCancels == nil {
		m.currentCancels = make(map[string]context.CancelFunc)
	}
	m.currentCancels[galleryID] = cancel
}

func (m *Manager) clearActiveGallery(galleryID string) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	delete(m.currentCancels, galleryID)
}

func (m *Manager) isShuttingDown() bool {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.shuttingDown
}

func (m *Manager) CancelDownloads() int {
	m.stateMu.Lock()
	cancels := make(map[string]context.CancelFunc, len(m.currentCancels))
	for galleryID, cancel := range m.currentCancels {
		cancels[galleryID] = cancel
	}
	m.batchInProgress = false
	m.stateMu.Unlock()

	for galleryID, cancel := range cancels {
		log.Printf("[DOWNLOADER] Cancelling active gallery: %s", galleryID)
		cancel()
	}

	clearedCount, err := m.db.CountQueue()
	if err != nil {
		log.Printf("[DOWNLOADER] Failed to count queue before clearing: %v", err)
		clearedCount = 0
	}
	if err := m.db.ClearQueue(); err != nil {
		log.Printf("[DOWNLOADER] Failed to clear queue after cancel: %v", err)
	}

	for {
		select {
		case queuedID, ok := <-m.jobCh:
			if !ok {
				m.clearCurrentProgress()
				return clearedCount
			}
			log.Printf("[DOWNLOADER] Removed queued gallery after cancel request: %s", queuedID)
		default:
			m.clearCurrentProgress()
			return clearedCount
		}
	}
}

func (m *Manager) markBatchSuccess() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	m.lastBatchSuccess++
}

func (m *Manager) markBatchFailure() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	m.lastBatchFailed++
}

func (m *Manager) galleryWorker(ctx context.Context) {
	defer m.wg.Done()
	log.Printf("[WORKER] Gallery worker started")

	interGalleryDelay := time.Duration(m.config.DownloadDelay * float64(time.Second))
	hasProcessedGallery := false

	for {
		select {
		case galleryID, ok := <-m.jobCh:
			if !ok {
				log.Printf("[WORKER] Gallery worker exiting (channel closed)")
				return
			}

			if hasProcessedGallery && interGalleryDelay > 0 {
				log.Printf("[WORKER] Waiting %s before next gallery", interGalleryDelay)
				timer := time.NewTimer(interGalleryDelay)
				select {
				case <-timer.C:
				case <-ctx.Done():
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					log.Printf("[WORKER] Gallery worker exiting (context cancelled)")
					return
				}
			}

			log.Printf("[WORKER] Processing gallery: %s", galleryID)
			m.processGallery(ctx, galleryID)
			hasProcessedGallery = true

		case <-ctx.Done():
			log.Printf("[WORKER] Gallery worker exiting (context cancelled)")
			return
		}
	}
}

func (m *Manager) processGallery(ctx context.Context, galleryID string) {
	jobCtx, jobCancel := context.WithCancel(ctx)
	m.setActiveGallery(galleryID, jobCancel)
	defer func() {
		jobCancel()
		m.clearActiveGallery(galleryID)
	}()

	log.Printf("[PROCESS] Starting download for gallery: %s", galleryID)
	// Mark as downloading
	if err := m.db.UpdateQueueStatus(galleryID, models.StatusDownloading, ""); err != nil {
		log.Printf("[PROCESS] Failed to update queue status: %v", err)
		return
	}
	log.Printf("[PROCESS] Status updated to downloading for: %s", galleryID)

	// Get queue entry
	entry, err := m.db.GetQueueByID(galleryID)
	if err != nil {
		log.Printf("Failed to get queue entry: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	if entry == nil {
		log.Printf("Queue entry not found: %s", galleryID)
		return
	}

	// Fetch gallery metadata
	gallery, err := m.nhentai.FetchGallery(jobCtx, galleryID)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			m.cancelGallery(galleryID, "Cancelled by user")
			return
		}
		if errors.Is(err, nhentai.ErrGalleryNotFound) {
			m.failGallery(galleryID, "Gallery not found")
		} else {
			m.failGallery(galleryID, err.Error())
		}
		return
	}

	// Check if already owned
	owned, err := m.db.GetOwnedByMediaID(gallery.MediaID)
	if err != nil {
		log.Printf("Failed to check owned: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	if owned != nil {
		m.db.UpdateQueueStatus(galleryID, models.StatusDuplicate, "")
		m.recordHistory(galleryID, "duplicate", "")
		return
	}

	// Create temp directory
	downloadPath := m.config.EffectiveDownloadPath()
	if err := os.MkdirAll(downloadPath, 0755); err != nil {
		log.Printf("[PROCESS] Failed to create download path: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}

	tempDir, err := os.MkdirTemp(downloadPath, "doujinshi-*")
	if err != nil {
		log.Printf("Failed to create temp dir: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	defer os.RemoveAll(tempDir)

	// Download pages
	tracker := NewProgressTracker(galleryID, gallery.Title.Pretty, gallery.NumPages)
	var downloadedPages []string

	err = downloadPages(jobCtx, m.nhentai, gallery.Pages, tempDir, m.config.PageWorkers, func(current, total int) {
		tracker.Update(current)
		progress := tracker.ToProgress()
		m.setCurrentProgress(progress)
		select {
		case m.progress <- progress:
		default:
		}
	})

	if err != nil {
		if errors.Is(err, context.Canceled) {
			log.Printf("[PROCESS] Download cancelled for gallery: %s", galleryID)
			m.cancelGallery(galleryID, "Cancelled by user")
			return
		}
		log.Printf("Failed to download pages: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}

	if err := jobCtx.Err(); err != nil {
		m.cancelGallery(galleryID, "Cancelled by user")
		return
	}

	// Collect downloaded files
	files, err := filepath.Glob(filepath.Join(tempDir, "*"))
	if err != nil {
		log.Printf("Failed to list downloaded files: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	downloadedPages = files

	// Build CBZ
	buildInput := library.BuildInput{
		Gallery:   gallery,
		PageFiles: downloadedPages,
		TempDir:   tempDir,
	}

	result, err := m.library.Build(buildInput)
	if err != nil {
		log.Printf("Failed to build CBZ: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}

	// Insert into owned
	ownedEntry := &models.OwnedEntry{
		ID:      galleryID,
		MediaID: gallery.MediaID,
		Title:   gallery.Title.Pretty,
		Artist:  result.ArtistFolder,
		AddedAt: time.Now(),
	}
	if err := m.db.InsertOwned(ownedEntry); err != nil {
		log.Printf("Failed to insert owned: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}

	// Mark as done
	tracker.Complete()
	progress := tracker.ToProgress()
	m.setCurrentProgress(progress)
	select {
	case m.progress <- progress:
	default:
	}
	m.markBatchSuccess()

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusDone, ""); err != nil {
		log.Printf("Failed to update status to done: %v", err)
	}

	m.recordHistory(galleryID, "success", "")
}

func (m *Manager) cancelGallery(galleryID, reason string) {
	entry, _ := m.db.GetQueueByID(galleryID)
	title := galleryID
	if entry != nil && entry.Title != "" {
		title = entry.Title
	}

	progress := models.DownloadProgress{
		GalleryID:   galleryID,
		Title:       title,
		CurrentPage: 0,
		TotalPages:  0,
		Percentage:  0,
		Status:      "cancelled",
	}
	m.setCurrentProgress(progress)
	select {
	case m.progress <- progress:
	default:
	}
	m.clearCurrentProgress()

	if m.isShuttingDown() {
		if err := m.db.UpdateQueueStatus(galleryID, models.StatusFailed, "Interrupted during shutdown"); err != nil {
			log.Printf("Failed to update status to failed during shutdown: %v", err)
		}
		m.recordHistory(galleryID, "failed", "Interrupted during shutdown")
		return
	}

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusPending, reason); err != nil {
		log.Printf("Failed to update status to pending after cancel: %v", err)
	}
	m.recordHistory(galleryID, "cancelled", reason)
}

func (m *Manager) failGallery(galleryID, errorMsg string) {
	entry, _ := m.db.GetQueueByID(galleryID)
	title := galleryID
	if entry != nil && entry.Title != "" {
		title = entry.Title
	}

	tracker := NewProgressTracker(galleryID, title, 0)
	tracker.Fail()
	progress := tracker.ToProgress()
	m.setCurrentProgress(progress)
	select {
	case m.progress <- progress:
	default:
	}
	m.markBatchFailure()

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusFailed, errorMsg); err != nil {
		log.Printf("Failed to update status to failed: %v", err)
	}
	m.recordHistory(galleryID, "failed", errorMsg)
}

func (m *Manager) recordHistory(galleryID, status, errorMsg string) {
	entry := &models.HistoryEntry{
		GalleryID: galleryID,
		Status:    status,
		Error:     errorMsg,
		Timestamp: time.Now(),
	}
	if err := m.db.InsertHistory(entry); err != nil {
		log.Printf("Failed to record history: %v", err)
	}
}
