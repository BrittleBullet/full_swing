package nhentai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	APIBase                = "https://nhentai.net/api/v2"
	MaxRetries             = 3
	BackoffBase            = 2.0
	MetadataRequestTimeout = 10 * time.Second
	PageDownloadTimeout    = 30 * time.Second
)

var (
	ErrGalleryNotFound   = errors.New("gallery not found")
	ErrMaxRetriesReached = errors.New("max retries exceeded")
	imageHosts           = []string{
		"https://i1.nhentai.net",
		"https://i2.nhentai.net",
		"https://i3.nhentai.net",
		"https://i4.nhentai.net",
		"https://i5.nhentai.net",
		"https://i6.nhentai.net",
		"https://i7.nhentai.net",
	}
)

// Client fetches gallery metadata and page images from nhentai.
type Client struct {
	http *http.Client
}

// NewClient creates a reusable HTTP client tuned for metadata and image requests.
func NewClient() *Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		MaxConnsPerHost:       20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true,
	}

	return &Client{
		http: &http.Client{
			Transport: transport,
			Timeout:   PageDownloadTimeout,
		},
	}
}

// FetchGallery retrieves gallery metadata from the nhentai API.
func (c *Client) FetchGallery(ctx context.Context, id string) (*Gallery, error) {
	requestCtx := contextOrBackground(ctx)
	url := fmt.Sprintf("%s/galleries/%s", APIBase, id)

	for attempt := 1; attempt <= MaxRetries; attempt++ {
		attemptCtx, cancel := context.WithTimeout(requestCtx, MetadataRequestTimeout)
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, url, nil)
		if err != nil {
			cancel()
			return nil, err
		}

		resp, err := c.http.Do(req)
		if err != nil {
			cancel()
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
			return nil, err
		}

		switch resp.StatusCode {
		case http.StatusOK:
			var gallery Gallery
			err = json.NewDecoder(resp.Body).Decode(&gallery)
			resp.Body.Close()
			cancel()
			if err != nil {
				return nil, err
			}
			return &gallery, nil
		case http.StatusNotFound:
			resp.Body.Close()
			cancel()
			return nil, ErrGalleryNotFound
		case http.StatusTooManyRequests:
			wait := retryBackoff(attempt, resp.Header.Get("Retry-After"))
			resp.Body.Close()
			cancel()
			if attempt == MaxRetries {
				return nil, fmt.Errorf("%w after %d attempts", ErrMaxRetriesReached, MaxRetries)
			}
			log.Printf("[NHENTAI] Metadata fetch for %s hit 429; retrying in %s (attempt %d/%d)", id, wait, attempt, MaxRetries)
			if err := sleepWithContext(requestCtx, wait); err != nil {
				return nil, err
			}
		default:
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			cancel()
			if len(body) > 0 {
				return nil, fmt.Errorf("api returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
			}
			return nil, fmt.Errorf("api returned status %d", resp.StatusCode)
		}
	}

	return nil, ErrMaxRetriesReached
}

// DownloadPage downloads a single image page with mirror fallback and atomic temp writes.
func (c *Client) DownloadPage(ctx context.Context, path string, destPath string) error {
	candidates := buildPathCandidates(path)
	var lastErr error

	for _, candidate := range candidates {
		normalizedPath := normalizePagePath(candidate)
		for _, host := range imageHosts {
			url := host + normalizedPath
			if err := c.downloadFromURL(ctx, url, destPath); err == nil {
				return nil
			} else {
				lastErr = err
			}
		}
	}

	if lastErr != nil {
		log.Printf("[NHENTAI] All image mirrors failed for %s: %v", path, lastErr)
		return fmt.Errorf("all mirrors failed: %w", lastErr)
	}
	return fmt.Errorf("failed to download page")
}

func (c *Client) downloadFromURL(ctx context.Context, url string, destPath string) error {
	requestCtx, cancel := context.WithTimeout(contextOrBackground(ctx), PageDownloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, url, nil)
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

	tempPath := destPath + ".part"
	_ = os.Remove(tempPath)

	file, err := os.Create(tempPath)
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(file, resp.Body)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(tempPath)
		return copyErr
	}
	if syncErr != nil {
		_ = os.Remove(tempPath)
		return syncErr
	}
	if closeErr != nil {
		_ = os.Remove(tempPath)
		return closeErr
	}
	if err := os.Rename(tempPath, destPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
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

func parseRetryAfter(value string) time.Duration {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(trimmed); err == nil {
		if seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		return 0
	}
	if retryTime, err := http.ParseTime(trimmed); err == nil {
		wait := time.Until(retryTime)
		if wait > 0 {
			return wait
		}
	}
	return 0
}

func retryBackoff(attempt int, retryAfter string) time.Duration {
	if wait := parseRetryAfter(retryAfter); wait > 0 {
		return wait
	}
	multiplier := 1 << uint(attempt-1)
	return time.Duration(BackoffBase*float64(multiplier)) * time.Second
}

func sleepWithContext(ctx context.Context, wait time.Duration) error {
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
