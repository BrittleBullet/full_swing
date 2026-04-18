package nhentai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	APIBase                = "https://nhentai.net/api/v2"
	ImageBase              = "https://i.nhentai.net"
	MaxRetries             = 5
	BackoffBase            = 2.0 // seconds
	MetadataRequestTimeout = 10 * time.Second
	PageDownloadTimeout    = 30 * time.Second
)

var (
	ErrGalleryNotFound = errors.New("gallery not found")
)

type Client struct {
	http     *http.Client
	apiDelay time.Duration
}

func NewClient(apiDelay float64, pageWorkers int) *Client {
	if pageWorkers < 1 {
		pageWorkers = 1
	}

	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        pageWorkers * 2,
		MaxIdleConnsPerHost: pageWorkers,
		IdleConnTimeout:     90 * time.Second,
	}

	return &Client{
		http:     &http.Client{Transport: transport},
		apiDelay: time.Duration(apiDelay * float64(time.Second)),
	}
}

func (c *Client) FetchGallery(ctx context.Context, id string) (*Gallery, error) {
	log.Printf("[NHENTAI] FetchGallery called with ID: %s", id)
	requestCtx, cancel := context.WithTimeout(contextOrBackground(ctx), MetadataRequestTimeout)
	defer cancel()

	if c.apiDelay > 0 {
		timer := time.NewTimer(c.apiDelay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-requestCtx.Done():
			return nil, requestCtx.Err()
		}
	}

	var result *Gallery
	err := c.fetchWithRetry(requestCtx, func() error {
		url := fmt.Sprintf("%s/galleries/%s", APIBase, id)
		log.Printf("[NHENTAI] Making request to: %s", url)
		req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			log.Printf("[NHENTAI] Request failed: %v", err)
			return err
		}
		defer resp.Body.Close()

		log.Printf("[NHENTAI] Response status: %d", resp.StatusCode)
		if resp.StatusCode == 404 {
			log.Printf("[NHENTAI] Gallery %s not found (404)", id)
			return ErrGalleryNotFound
		}
		if resp.StatusCode != 200 {
			return fmt.Errorf("API returned status %d", resp.StatusCode)
		}

		var gallery Gallery
		if err := json.NewDecoder(resp.Body).Decode(&gallery); err != nil {
			log.Printf("[NHENTAI] Failed to decode gallery JSON: %v", err)
			return err
		}

		log.Printf("[NHENTAI] Successfully fetched gallery: ID=%v, MediaID=%s", gallery.ID, gallery.MediaID)
		result = &gallery
		return nil
	})
	return result, err
}

func (c *Client) DownloadPage(ctx context.Context, path string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(contextOrBackground(ctx), PageDownloadTimeout)
	defer cancel()

	candidates := buildPathCandidates(path)
	var lastErr error

	for _, candidate := range candidates {
		var result []byte
		err := c.fetchWithRetry(requestCtx, func() error {
			normalizedPath := normalizePagePath(candidate)
			url := fmt.Sprintf("%s%s", ImageBase, normalizedPath)
			log.Printf("[NHENTAI] Downloading page from: %s", url)

			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return err
			}
			req.Header.Set("User-Agent", "Mozilla/5.0")
			req.Header.Set("Referer", "https://nhentai.net/")

			resp, err := c.http.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("download returned status %d", resp.StatusCode)
			}

			data, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}

			result = data
			return nil
		})
		if err == nil {
			return result, nil
		}

		lastErr = err
		log.Printf("[NHENTAI] Page candidate failed for %s: %v", candidate, err)
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("failed to download page")
}

func contextOrBackground(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

func buildPathCandidates(path string) []string {
	candidates := []string{path}
	dot := strings.LastIndex(path, ".")
	if dot == -1 {
		return candidates
	}

	base := path[:dot]
	seen := map[string]bool{path: true}
	for _, ext := range []string{".jpg", ".png", ".gif", ".webp"} {
		candidate := base + ext
		if !seen[candidate] {
			candidates = append(candidates, candidate)
			seen[candidate] = true
		}
	}

	return candidates
}

func normalizePagePath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "/"
	}
	if strings.HasPrefix(trimmed, "/") {
		return trimmed
	}
	return "/" + trimmed
}

func (c *Client) fetchWithRetry(ctx context.Context, fn func() error) error {
	for attempt := 0; attempt < MaxRetries; attempt++ {
		if ctx != nil {
			if err := ctx.Err(); err != nil {
				return err
			}
		}

		err := fn()
		if err == nil {
			return nil
		}

		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}

		// Don't retry on gallery not found
		if errors.Is(err, ErrGalleryNotFound) {
			return err
		}

		// Exponential backoff for retries
		if attempt < MaxRetries-1 {
			multiplier := 1 << uint(attempt)
			backoffSeconds := BackoffBase * float64(multiplier)
			backoff := time.Duration(backoffSeconds * float64(time.Second))

			if ctx == nil {
				time.Sleep(backoff)
			} else {
				timer := time.NewTimer(backoff)
				select {
				case <-timer.C:
				case <-ctx.Done():
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					return ctx.Err()
				}
			}
		}
	}

	return fmt.Errorf("max retries exceeded")
}
