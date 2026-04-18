package downloader

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"doujinshi-manager/internal/nhentai"
)

type DownloadResult struct {
	Path  string
	Error error
}

// downloadPages downloads all pages for a gallery using a bounded worker pool
func downloadPages(
	ctx context.Context,
	client *nhentai.Client,
	pages []nhentai.Page,
	destDir string,
	workers int,
	progress func(current, total int),
) error {
	if len(pages) == 0 {
		return nil
	}

	// Create jobs channel
	jobs := make(chan downloadJob, len(pages))
	results := make(chan DownloadResult, len(pages))

	// Start workers
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker(ctx, client, jobs, results)
		}()
	}

	// Send jobs
	for i, page := range pages {
		select {
		case jobs <- downloadJob{page: page, index: i, destDir: destDir}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	close(jobs)

	// Collect results
	go func() {
		wg.Wait()
		close(results)
	}()

	// Process results
	completed := 0
	total := len(pages)
	for completed < total {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case result, ok := <-results:
			if !ok {
				return nil
			}
			if result.Error != nil {
				return result.Error
			}
			completed++
			if progress != nil {
				progress(completed, total)
			}
		}
	}

	return nil
}

type downloadJob struct {
	page    nhentai.Page
	index   int
	destDir string
}

func worker(ctx context.Context, client *nhentai.Client, jobs <-chan downloadJob, results chan<- DownloadResult) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}

		select {
		case job, ok := <-jobs:
			if !ok {
				return
			}

			if err := ctx.Err(); err != nil {
				return
			}

			path, err := downloadPage(ctx, client, job)
			results <- DownloadResult{Path: path, Error: err}

		case <-ctx.Done():
			return
		}
	}
}

func downloadPage(ctx context.Context, client *nhentai.Client, job downloadJob) (string, error) {
	// Download the page
	data, err := client.DownloadPage(ctx, job.page.Path)
	if err != nil {
		return "", fmt.Errorf("failed to download page %d: %w", job.page.Number, err)
	}

	// Determine filename
	ext := filepath.Ext(job.page.Path)
	if ext == "" {
		ext = ".jpg" // fallback
	}
	filename := fmt.Sprintf("%03d%s", job.index+1, ext)
	filePath := filepath.Join(job.destDir, filename)

	// Write to file
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write page %d: %w", job.page.Number, err)
	}

	return filePath, nil
}
