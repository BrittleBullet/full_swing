package appversion

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const versionFileName = "VERSION"
const fallbackVersion = "unknown"

var (
	loadOnce sync.Once
	value    = fallbackVersion
)

// Current returns the application version loaded from the shared VERSION file.
func Current() string {
	loadOnce.Do(func() {
		value = loadVersion()
	})
	return value
}

func loadVersion() string {
	for _, startDir := range candidateDirectories() {
		if startDir == "" {
			continue
		}
		if version := searchUpwards(startDir); version != "" {
			return version
		}
	}
	return fallbackVersion
}

func candidateDirectories() []string {
	directories := make([]string, 0, 2)
	if cwd, err := os.Getwd(); err == nil {
		directories = append(directories, cwd)
	}
	if executablePath, err := os.Executable(); err == nil {
		directories = append(directories, filepath.Dir(executablePath))
	}
	return directories
}

func searchUpwards(startDir string) string {
	currentDir := filepath.Clean(startDir)
	for {
		versionPath := filepath.Join(currentDir, versionFileName)
		if data, err := os.ReadFile(versionPath); err == nil {
			if version := strings.TrimSpace(string(data)); version != "" {
				return version
			}
		}

		parentDir := filepath.Dir(currentDir)
		if parentDir == currentDir {
			return ""
		}
		currentDir = parentDir
	}
}
