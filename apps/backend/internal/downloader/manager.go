package downloader

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"doujinshi-manager/internal/config"
	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/library"
	"doujinshi-manager/internal/models"
	"doujinshi-manager/internal/nhentai"
)

// Manager coordinates gallery downloads, progress publication, and graceful shutdown.
type Manager struct {
	db      *database.DB
	nhentai *nhentai.Client
	library *library.Builder
	config  *config.Config

	jobCh    chan string
	progress chan models.DownloadProgress
	cancel   context.CancelFunc
	runCtx   context.Context
	wg       sync.WaitGroup

	stateMu               sync.RWMutex
	currentProgress       *models.DownloadProgress
	lastBatchSuccess      int
	lastBatchFailed       int
	batchInProgress       bool
	batchStartedAt        time.Time
	currentGalleryID      string
	currentGalleryStarted time.Time
	shuttingDown          bool
	paused                bool
	currentCancels        map[string]context.CancelFunc
	scheduledIDs          map[string]struct{}
	subscribers           map[int]chan models.DownloadProgress
	nextSubscriberID      int
}

// NewManager creates a downloader manager with the provided dependencies.
func NewManager(db *database.DB, nhentai *nhentai.Client, library *library.Builder, config *config.Config) *Manager {
	return &Manager{
		db:             db,
		nhentai:        nhentai,
		library:        library,
		config:         config,
		jobCh:          make(chan string, 4096),
		progress:       make(chan models.DownloadProgress, 100),
		currentCancels: make(map[string]context.CancelFunc),
		scheduledIDs:   make(map[string]struct{}),
		subscribers:    make(map[int]chan models.DownloadProgress),
	}
}

// Start launches the gallery worker pool until the context is cancelled.
func (m *Manager) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	m.runCtx = ctx
	m.stateMu.Lock()
	m.shuttingDown = false
	m.paused = false
	m.stateMu.Unlock()

	log.Printf("[DOWNLOADER] Starting downloader manager with %d gallery workers", m.config.GalleryWorkers)
	for i := 0; i < m.config.GalleryWorkers; i++ {
		m.wg.Add(1)
		go m.galleryWorker(ctx)
	}
	log.Printf("[DOWNLOADER] Downloader manager started")
}

// Stop cancels all active work and closes manager resources.
func (m *Manager) Stop() {
	m.stateMu.Lock()
	m.shuttingDown = true
	m.stateMu.Unlock()
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
	close(m.jobCh)

	m.stateMu.Lock()
	subscribers := make([]chan models.DownloadProgress, 0, len(m.subscribers))
	for id, ch := range m.subscribers {
		subscribers = append(subscribers, ch)
		delete(m.subscribers, id)
	}
	m.stateMu.Unlock()

	for _, ch := range subscribers {
		close(ch)
	}
	close(m.progress)
}

// Enqueue schedules gallery IDs for download without duplicating active work.
func (m *Manager) Enqueue(ids []string) error {
	log.Printf("[ENQUEUE] Attempting to enqueue %d galleries", len(ids))
	if len(ids) == 0 {
		return nil
	}
	m.beginBatch()

	runCtx := m.runCtx
	if runCtx == nil {
		runCtx = context.Background()
	}

	queued := 0
	for _, id := range ids {
		if !m.markScheduled(id) {
			log.Printf("[ENQUEUE] Skipping already scheduled gallery: %s", id)
			continue
		}

		select {
		case m.jobCh <- id:
			queued++
			log.Printf("[ENQUEUE] Enqueued gallery: %s", id)
		case <-runCtx.Done():
			m.unmarkScheduled(id)
			return runCtx.Err()
		}
	}

	log.Printf("[ENQUEUE] Queued %d gallery downloads", queued)
	return nil
}

// Progress returns a dedicated subscription channel for download updates.
func (m *Manager) Progress() <-chan models.DownloadProgress {
	ch, _ := m.SubscribeProgress()
	return ch
}

// SubscribeProgress registers a progress listener and returns a cleanup function.
func (m *Manager) SubscribeProgress() (<-chan models.DownloadProgress, func()) {
	ch := make(chan models.DownloadProgress, 16)

	m.stateMu.Lock()
	if m.subscribers == nil {
		m.subscribers = make(map[int]chan models.DownloadProgress)
	}
	id := m.nextSubscriberID
	m.nextSubscriberID++
	m.subscribers[id] = ch
	m.stateMu.Unlock()

	cleanup := func() {
		m.stateMu.Lock()
		registered, ok := m.subscribers[id]
		if ok {
			delete(m.subscribers, id)
		}
		m.stateMu.Unlock()
		if ok {
			close(registered)
		}
	}

	return ch, cleanup
}

// CurrentProgress returns the latest download snapshot, if one is available.
func (m *Manager) CurrentProgress() *models.DownloadProgress {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()

	if m.currentProgress == nil {
		return nil
	}

	copy := *m.currentProgress
	if isActiveProgressStatus(copy.Status) {
		if !m.batchStartedAt.IsZero() {
			copy.BatchElapsedMs = time.Since(m.batchStartedAt).Milliseconds()
		}
		if copy.GalleryID != "" && copy.GalleryID == m.currentGalleryID && !m.currentGalleryStarted.IsZero() {
			copy.GalleryElapsedMs = time.Since(m.currentGalleryStarted).Milliseconds()
		}
	}
	return &copy
}

// LastBatchResults returns the success and failure counts for the most recent batch.
func (m *Manager) LastBatchResults() (int, int) {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.lastBatchSuccess, m.lastBatchFailed
}

// IsPaused reports whether the current batch has been manually paused.
func (m *Manager) IsPaused() bool {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.paused
}

func (m *Manager) beginBatch() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	if !m.batchInProgress {
		m.lastBatchSuccess = 0
		m.lastBatchFailed = 0
		m.batchStartedAt = time.Now()
		m.currentProgress = nil
		m.currentGalleryID = ""
		m.currentGalleryStarted = time.Time{}
	}
	m.batchInProgress = true
	m.paused = false
}

func (m *Manager) setCurrentProgress(progress models.DownloadProgress) models.DownloadProgress {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if progress.BatchElapsedMs == 0 && !m.batchStartedAt.IsZero() {
		progress.BatchElapsedMs = time.Since(m.batchStartedAt).Milliseconds()
	}
	if progress.GalleryID != "" {
		galleryChanged := m.currentGalleryID != progress.GalleryID
		m.currentGalleryID = progress.GalleryID
		if progress.GalleryElapsedMs > 0 {
			m.currentGalleryStarted = time.Now().Add(-time.Duration(progress.GalleryElapsedMs) * time.Millisecond)
		} else if galleryChanged || m.currentGalleryStarted.IsZero() {
			m.currentGalleryStarted = time.Now()
		}
	}
	copy := progress
	m.currentProgress = &copy
	return copy
}

func (m *Manager) publishProgress(progress models.DownloadProgress) {
	progress = m.setCurrentProgress(progress)

	select {
	case m.progress <- progress:
	default:
	}

	m.stateMu.RLock()
	subscribers := make([]chan models.DownloadProgress, 0, len(m.subscribers))
	for _, ch := range m.subscribers {
		subscribers = append(subscribers, ch)
	}
	m.stateMu.RUnlock()

	for _, ch := range subscribers {
		select {
		case ch <- progress:
		default:
		}
	}
}

func (m *Manager) clearCurrentProgress() {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	m.currentProgress = nil
	m.batchInProgress = false
	m.batchStartedAt = time.Time{}
	m.currentGalleryID = ""
	m.currentGalleryStarted = time.Time{}
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

func (m *Manager) markScheduled(galleryID string) bool {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if m.scheduledIDs == nil {
		m.scheduledIDs = make(map[string]struct{})
	}
	if _, exists := m.scheduledIDs[galleryID]; exists {
		return false
	}
	m.scheduledIDs[galleryID] = struct{}{}
	return true
}

func (m *Manager) unmarkScheduled(galleryID string) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	delete(m.scheduledIDs, galleryID)
}

func (m *Manager) isShuttingDown() bool {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.shuttingDown
}

// PauseDownloads stops active work and keeps queued items pending for a later resume.
func (m *Manager) PauseDownloads() int {
	m.stateMu.Lock()
	cancels := make(map[string]context.CancelFunc, len(m.currentCancels))
	for galleryID, cancel := range m.currentCancels {
		cancels[galleryID] = cancel
	}
	m.batchInProgress = false
	m.paused = true
	m.stateMu.Unlock()

	for galleryID, cancel := range cancels {
		log.Printf("[DOWNLOADER] Pausing active gallery: %s", galleryID)
		cancel()
	}

	pausedCount := len(cancels)
	for {
		select {
		case queuedID, ok := <-m.jobCh:
			if !ok {
				m.clearCurrentProgress()
				return pausedCount
			}
			pausedCount++
			m.unmarkScheduled(queuedID)
			log.Printf("[DOWNLOADER] Removed queued gallery from the active batch after pause request: %s", queuedID)
		default:
			m.clearCurrentProgress()
			return pausedCount
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

	for {
		select {
		case galleryID, ok := <-m.jobCh:
			if !ok {
				log.Printf("[WORKER] Gallery worker exiting (channel closed)")
				return
			}

			log.Printf("[WORKER] Processing gallery: %s", galleryID)
			m.processGallery(ctx, galleryID)

		case <-ctx.Done():
			log.Printf("[WORKER] Gallery worker exiting (context cancelled)")
			return
		}
	}
}

func (m *Manager) processGallery(ctx context.Context, galleryID string) {
	jobCtx, jobCancel := context.WithCancel(ctx)
	galleryStartedAt := time.Now()
	m.setActiveGallery(galleryID, jobCancel)
	defer func() {
		jobCancel()
		m.clearActiveGallery(galleryID)
		m.unmarkScheduled(galleryID)
	}()

	log.Printf("[PROCESS] Starting download for gallery: %s", galleryID)

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
	if entry.Status != models.StatusPending && entry.Status != models.StatusDownloading {
		log.Printf("[PROCESS] Skipping gallery %s with status %s", galleryID, entry.Status)
		return
	}

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusDownloading, ""); err != nil {
		log.Printf("[PROCESS] Failed to update queue status: %v", err)
		return
	}
	log.Printf("[PROCESS] Status updated to downloading for: %s", galleryID)

	displayTitle := galleryID
	if trimmedTitle := strings.TrimSpace(entry.Title); trimmedTitle != "" {
		displayTitle = trimmedTitle
	}

	preparingProgress := models.DownloadProgress{
		GalleryID:        galleryID,
		Title:            displayTitle,
		CurrentPage:      0,
		TotalPages:       0,
		Percentage:       0,
		Status:           "preparing",
		GalleryElapsedMs: time.Since(galleryStartedAt).Milliseconds(),
	}
	m.publishProgress(preparingProgress)

	gallery, err := m.nhentai.FetchGallery(jobCtx, galleryID)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			m.cancelGallery(galleryID, "Cancelled by user")
			return
		}
		if errors.Is(err, nhentai.ErrGalleryNotFound) {
			m.notFoundGallery(galleryID, "Gallery not found")
		} else {
			m.failGallery(galleryID, err.Error())
		}
		return
	}

	delay := time.Duration(m.config.APIRequestDelay * float64(time.Second))
	if delay > 0 {
		log.Printf("[PROCESS] Courtesy wait after metadata fetch: %s", delay)
		if !waitForContext(jobCtx, delay) {
			m.cancelGallery(galleryID, "Cancelled by user")
			return
		}
	}

	if trimmedTitle := strings.TrimSpace(gallery.Title.Pretty); trimmedTitle != "" {
		displayTitle = trimmedTitle
	}

	preparingProgress = models.DownloadProgress{
		GalleryID:        galleryID,
		Title:            displayTitle,
		CurrentPage:      0,
		TotalPages:       gallery.NumPages,
		Percentage:       0,
		Status:           "preparing",
		GalleryElapsedMs: time.Since(galleryStartedAt).Milliseconds(),
	}
	m.publishProgress(preparingProgress)

	artist := extractGalleryArtist(gallery)
	go func(id, title, artist string) {
		if err := m.db.UpdateQueueMetadata(id, title, artist); err != nil {
			log.Printf("[PROCESS] Failed to update queue metadata: %v", err)
		}
	}(galleryID, displayTitle, artist)

	owned, err := m.db.GetOwnedByMediaID(gallery.MediaID)
	if err != nil {
		log.Printf("Failed to check owned: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	if owned != nil {
		if err := m.db.UpdateQueueStatus(galleryID, models.StatusDuplicate, ""); err != nil {
			log.Printf("Failed to update status to duplicate: %v", err)
		}
		m.recordHistory(galleryID, models.HistoryStatusDuplicate, "")
		m.finishBatchIfIdle()
		return
	}

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

	tracker := NewProgressTracker(galleryID, displayTitle, gallery.NumPages)
	var downloadedPages []string

	err = downloadPages(jobCtx, m.nhentai, gallery.Pages, tempDir, m.config.PageWorkers, func(current, total int) {
		tracker.Update(current)
		progress := tracker.ToProgress()
		progress.GalleryElapsedMs = time.Since(galleryStartedAt).Milliseconds()
		m.publishProgress(progress)
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

	finalizingProgress := models.DownloadProgress{
		GalleryID:        galleryID,
		Title:            displayTitle,
		CurrentPage:      gallery.NumPages,
		TotalPages:       gallery.NumPages,
		Percentage:       100,
		Status:           "finalizing",
		GalleryElapsedMs: time.Since(galleryStartedAt).Milliseconds(),
	}
	m.publishProgress(finalizingProgress)

	files, err := filepath.Glob(filepath.Join(tempDir, "*"))
	if err != nil {
		log.Printf("Failed to list downloaded files: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	downloadedPages = files

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

	ownedEntry := &models.OwnedEntry{
		ID:      galleryID,
		MediaID: gallery.MediaID,
		Title:   result.Title,
		Artist:  result.ArtistFolder,
		AddedAt: time.Now(),
	}
	if err := m.db.InsertOwned(ownedEntry); err != nil {
		log.Printf("Failed to insert owned: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}
	if err := m.db.UpdateQueueStatus(galleryID, models.StatusDone, ""); err != nil {
		log.Printf("Failed to update status to done: %v", err)
		m.failGallery(galleryID, err.Error())
		return
	}

	tracker.Complete()
	progress := tracker.ToProgress()
	progress.GalleryElapsedMs = time.Since(galleryStartedAt).Milliseconds()
	m.publishProgress(progress)
	m.markBatchSuccess()
	go m.recordHistory(galleryID, models.HistoryStatusSuccess, "")
	m.finishBatchIfIdle()
}

func (m *Manager) finishBatchIfIdle() {
	pendingCount, err := m.db.CountQueueByStatus(models.StatusPending)
	if err != nil {
		log.Printf("[DOWNLOADER] Failed to count pending queue items: %v", err)
		return
	}

	downloadingCount, err := m.db.CountQueueByStatus(models.StatusDownloading)
	if err != nil {
		log.Printf("[DOWNLOADER] Failed to count active downloads: %v", err)
		return
	}

	if pendingCount == 0 && downloadingCount == 0 {
		m.stateMu.Lock()
		m.batchInProgress = false
		m.batchStartedAt = time.Time{}
		m.currentGalleryID = ""
		m.currentGalleryStarted = time.Time{}
		m.paused = false
		m.stateMu.Unlock()
	}
}

func (m *Manager) cancelGallery(galleryID, reason string) {
	entry, err := m.db.GetQueueByID(galleryID)
	if err != nil {
		log.Printf("Failed to get queue entry during cancel: %v", err)
	}
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
	m.publishProgress(progress)
	m.clearCurrentProgress()

	if m.isShuttingDown() {
		if err := m.db.UpdateQueueStatus(galleryID, models.StatusFailed, "Interrupted during shutdown"); err != nil {
			log.Printf("Failed to update status to failed during shutdown: %v", err)
		}
		m.recordHistory(galleryID, models.HistoryStatusFailed, "Interrupted during shutdown")
		return
	}

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusPending, reason); err != nil {
		log.Printf("Failed to update status to pending after cancel: %v", err)
	}
	m.recordHistory(galleryID, models.HistoryStatusCancelled, reason)
}

func (m *Manager) notFoundGallery(galleryID, errorMsg string) {
	entry, err := m.db.GetQueueByID(galleryID)
	if err != nil {
		log.Printf("Failed to get queue entry for not-found status: %v", err)
	}
	title := galleryID
	if entry != nil && entry.Title != "" {
		title = entry.Title
	}

	tracker := NewProgressTracker(galleryID, title, 0)
	tracker.Fail()
	progress := tracker.ToProgress()
	m.publishProgress(progress)
	m.markBatchFailure()

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusNotFound, errorMsg); err != nil {
		log.Printf("Failed to update status to not_found: %v", err)
	}
	m.recordHistory(galleryID, models.HistoryStatusNotFound, errorMsg)
	m.finishBatchIfIdle()
}

func (m *Manager) failGallery(galleryID, errorMsg string) {
	entry, err := m.db.GetQueueByID(galleryID)
	if err != nil {
		log.Printf("Failed to get queue entry for failure status: %v", err)
	}
	title := galleryID
	if entry != nil && entry.Title != "" {
		title = entry.Title
	}

	tracker := NewProgressTracker(galleryID, title, 0)
	tracker.Fail()
	progress := tracker.ToProgress()
	m.publishProgress(progress)
	m.markBatchFailure()

	if err := m.db.UpdateQueueStatus(galleryID, models.StatusFailed, errorMsg); err != nil {
		log.Printf("Failed to update status to failed: %v", err)
	}
	m.recordHistory(galleryID, models.HistoryStatusFailed, errorMsg)
	m.finishBatchIfIdle()
}

func (m *Manager) recordHistory(galleryID string, status models.HistoryStatus, errorMsg string) {
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

func extractGalleryArtist(gallery *nhentai.Gallery) string {
	if gallery == nil {
		return ""
	}
	for _, tag := range gallery.Tags {
		if tag.Type == "artist" {
			return tag.Name
		}
	}
	for _, tag := range gallery.Tags {
		if tag.Type == "group" {
			return tag.Name
		}
	}
	return ""
}

func isActiveProgressStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "downloading", "preparing", "waiting", "finalizing":
		return true
	default:
		return false
	}
}

func waitForContext(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return true
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
