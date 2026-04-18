package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"doujinshi-manager/internal/api"
	"doujinshi-manager/internal/config"
	"doujinshi-manager/internal/database"
	"doujinshi-manager/internal/downloader"
	"doujinshi-manager/internal/library"
	"doujinshi-manager/internal/nhentai"
)

func main() {
	configPath := flag.String("config", "", "Path to config file")
	flag.Parse()

	if *configPath == "" {
		// Default config path
		configDir, err := os.UserConfigDir()
		if err != nil {
			log.Fatal("Failed to get config dir:", err)
		}
		*configPath = filepath.Join(configDir, "doujinshi-manager", "config.json")
	}

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.Fatal("Failed to load config:", err)
	}

	// Ensure config is saved if it didn't exist
	if err := cfg.Save(*configPath); err != nil {
		log.Fatal("Failed to save config:", err)
	}

	// Initialize database
	dbPath := filepath.Join(filepath.Dir(*configPath), "doujinshi.db")
	db, err := database.NewDB(dbPath)
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Initialize nhentai client
	nhentaiClient := nhentai.NewClient(cfg.APIRequestDelay, cfg.PageWorkers)

	// Initialize library components
	libraryBuilder := library.NewBuilder(cfg.LibraryPath)
	libraryScanner := library.NewScanner(cfg.LibraryPath, db)

	// Initialize downloader
	downloaderManager := downloader.NewManager(db, nhentaiClient, libraryBuilder, cfg)

	// Start downloader
	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	defer cancelRuntime()
	downloaderManager.Start(runtimeCtx)

	// Initialize API server
	server := api.NewServer(cfg, *configPath, db, nhentaiClient, downloaderManager, libraryScanner)
	router := server.Router()

	// Start HTTP server
	httpServer := &http.Server{
		Addr:    ":" + fmt.Sprintf("%d", cfg.ServerPort),
		Handler: router,
	}

	go func() {
		log.Printf("Starting server on port %d", cfg.ServerPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("Failed to start server:", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}

	cancelRuntime()
	downloaderManager.Stop()
	log.Println("Server exited")
}
