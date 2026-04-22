package api

import (
	"github.com/go-chi/chi/v5"

	"doujinshi-manager/internal/config"
	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/downloader"
	"doujinshi-manager/internal/library"
	"doujinshi-manager/internal/nhentai"
)

// Server bundles the local API dependencies and handlers.
type Server struct {
	config     *config.Config
	configPath string
	db         *database.DB
	nhentai    *nhentai.Client
	downloader *downloader.Manager
	library    *library.Scanner
}

// NewServer constructs an API server with the configured runtime dependencies.
func NewServer(cfg *config.Config, configPath string, db *database.DB, nhentai *nhentai.Client, dl *downloader.Manager, lib *library.Scanner) *Server {
	return &Server{
		config:     cfg,
		configPath: configPath,
		db:         db,
		nhentai:    nhentai,
		downloader: dl,
		library:    lib,
	}
}

// Router builds the application HTTP router.
func (s *Server) Router() *chi.Mux {
	r := chi.NewRouter()
	SetupMiddleware(r)

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Get("/status", s.handleStatus)
		r.Get("/owned/ids", s.handleOwnedIDs)
		r.Get("/owned/{id}", s.handleOwnedCheck)
		r.Post("/owned/check", s.handleOwnedCheckBatch)
		r.Delete("/owned", s.handleClearOwned)

		r.Get("/queue", s.handleListQueue)
		r.Post("/queue", s.handleEnqueue)
		r.Delete("/queue/{id}", s.handleDeleteQueue)
		r.Delete("/queue", s.handleClearQueue)

		r.Post("/download/start", s.handleDownloadStart)
		r.Post("/download/pause", s.handleDownloadPause)
		r.Post("/download/retry/{id}", s.handleDownloadRetry)
		r.Get("/download/progress", s.handleDownloadProgress)

		r.Get("/library", s.handleListLibrary)
		r.Post("/library/reconcile", s.handleLibraryReconcile)
		r.Get("/history", s.handleListHistory)

		r.Get("/settings", s.handleGetSettings)
		r.Put("/settings", s.handleUpdateSettings)

		r.Post("/migrate", s.handleMigrate)
	})

	return r
}
