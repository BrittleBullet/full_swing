package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
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
		resolvedConfigPath, err := resolveDefaultConfigPath()
		if err != nil {
			log.Fatal("Failed to resolve config path:", err)
		}
		*configPath = resolvedConfigPath
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
	nhentaiClient := nhentai.NewClient()

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

	// Start HTTP servers.
	servers := []*http.Server{{
		Addr:              net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", cfg.ServerPort)),
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}}

	if cfg.ServerPort != config.DefaultServerPort {
		servers = append(servers, &http.Server{
			Addr:              net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", config.DefaultServerPort)),
			Handler:           router,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
		})
	}

	for index, srv := range servers {
		go func(idx int, serverInstance *http.Server) {
			portLabel := serverInstance.Addr
			if idx == 0 {
				log.Printf("Starting primary server on %s", portLabel)
				if err := serverInstance.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					log.Fatal("Failed to start server:", err)
				}
				return
			}

			log.Printf("Starting compatibility server on %s for extension access", portLabel)
			if err := serverInstance.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("[WARN] compatibility server unavailable on %s: %v", portLabel, err)
			}
		}(index, srv)
	}

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, serverInstance := range servers {
		if err := serverInstance.Shutdown(shutdownCtx); err != nil {
			log.Printf("Server forced to shutdown on %s: %v", serverInstance.Addr, err)
		}
	}

	cancelRuntime()
	downloaderManager.Stop()
	log.Println("Server exited")
}

func resolveDefaultConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	newDir := filepath.Join(configDir, "Full Swing")
	legacyDir := filepath.Join(configDir, "doujinshi-manager")
	if err := migrateLegacyAppData(legacyDir, newDir); err != nil {
		log.Printf("[WARN] failed to migrate legacy app data: %v", err)
	}

	return filepath.Join(newDir, "config.json"), nil
}

func migrateLegacyAppData(legacyDir, newDir string) error {
	if legacyDir == newDir {
		return nil
	}
	if _, err := os.Stat(legacyDir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(newDir, 0755); err != nil {
		return err
	}

	for _, name := range []string{"config.json", "doujinshi.db"} {
		srcPath := filepath.Join(legacyDir, name)
		dstPath := filepath.Join(newDir, name)
		if err := copyFileIfMissing(srcPath, dstPath); err != nil {
			return err
		}
	}
	return nil
}

func copyFileIfMissing(srcPath, dstPath string) error {
	if _, err := os.Stat(dstPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := os.Stat(srcPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	srcFile, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
		return err
	}
	dstFile, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}
	return nil
}
